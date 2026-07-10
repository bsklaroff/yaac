import fs from 'node:fs/promises'
import path from 'node:path'
import type { SecretProxyRule } from '@/shared/types'
import { imageExists } from '@/lib/container/runtime'
import { PROXY_DIR } from '@/shared/project-paths'
import { buildImage, contextHash } from '@/lib/container/image-builder'
import {
  ensureCaConfigMap,
  ensureNamespace,
  ensureProxyAuthSecret,
  ensureProxyResources,
  PROXY_APP_NAME,
  PROXY_PORT,
} from '@/lib/k8s/bootstrap'
import { k8sNamespace, kubectlGetJson, kubectlWithRetry } from '@/lib/k8s/kubectl'
import { pushImageToRegistry, registryHasTag, registryRef } from '@/lib/k8s/registry'
import { ServicePortForward } from '@/lib/k8s/port-forward'
import { listSshEntries } from '@/lib/project/credentials'
import { serverLog } from '@/server/log'
import { env, testEnv } from '@/shared/env'

// --- Secret convention types & builder (merged from secret-conventions.ts) ---

export interface Injection {
  action: 'set_header' | 'replace_header' | 'remove_header' | 'replace_body_param'
  name: string
  value?: string
  /**
   * Reference to an entry in the proxy-secrets credentials file (keyed by
   * env var name) instead of a literal `value`. The proxy resolves it at
   * injection time from its credentials mount, which keeps registrations
   * secret-free — a hard requirement for the proxy persisting them to its
   * /data volume across pod replacements.
   */
  secretRef?: string
  /** Prefix prepended to the resolved secret (e.g. "Bearer "). */
  prefix?: string
}

export interface InjectionRule {
  hostPattern: string
  pathPattern: string
  injections: Injection[]
}

/**
 * Test-only: redirect the post-MITM upstream call for `hostname` to a mock
 * reachable from the proxy pod. Credential injection and TLS termination
 * still run normally; only the final upstream hop is diverted.
 */
export interface UpstreamRedirect {
  host: string
  port: number
  tls?: boolean
}

/**
 * Build proxy injection rules from yaac-config.json's envSecretProxy field.
 * Each entry maps an env var name to a SecretProxyRule that describes how to
 * inject the secret (as a header or body parameter).
 *
 * Rules carry the env var name as a `secretRef`, never the value — the
 * proxy resolves it per request from the proxy-secrets credentials file
 * (see `collectProxySecrets`), so registrations stay secret-free and a
 * value updated on disk applies to live sessions immediately.
 */
export function buildRulesFromConfig(
  envSecretProxy: Record<string, SecretProxyRule>,
  env: Record<string, string | undefined>,
): InjectionRule[] {
  const rules: InjectionRule[] = []

  for (const [envVar, rule] of Object.entries(envSecretProxy)) {
    if (!env[envVar]) {
      console.warn(`Warning: ${envVar} is not set in the environment, skipping proxy rule`)
      continue
    }

    const pathPattern = rule.path ?? '/*'

    let injections: Injection[]
    if (rule.bodyParam) {
      injections = [{ action: 'replace_body_param', name: rule.bodyParam, secretRef: envVar }]
    } else {
      const headerName = rule.header ?? 'authorization'
      const prefix = rule.prefix ?? (rule.header ? '' : 'Bearer ')
      injections = [{
        action: 'set_header',
        name: headerName,
        secretRef: envVar,
        ...(prefix ? { prefix } : {}),
      }]
    }

    for (const host of rule.hosts) {
      rules.push({ hostPattern: host, pathPattern, injections })
    }
  }

  return rules
}

/**
 * Collect the envSecretProxy values that are present in `env`, keyed by
 * env var name — the entries `buildRulesFromConfig`'s secretRefs resolve
 * against. Written to the proxy-secrets credentials file before each
 * registration.
 */
export function collectProxySecrets(
  envSecretProxy: Record<string, SecretProxyRule>,
  env: Record<string, string | undefined>,
): Record<string, string> {
  const secrets: Record<string, string> = {}
  for (const envVar of Object.keys(envSecretProxy)) {
    const value = env[envVar]
    if (value) secrets[envVar] = value
  }
  return secrets
}

// --- ProxyClient ---

/** Path inside session and proxy pods where the ssh-agent socket lives. */
export const SSH_AGENT_SOCKET_PATH = '/ssh-agent/socket'
/** Mount point inside pods for the shared agent-socket hostPath dir. */
export const SSH_AGENT_MOUNT = '/ssh-agent'

/** In-container path of the proxy CA cert (mounted from the ConfigMap). */
export const PROXY_CA_PATH = '/etc/yaac/certs/proxy-ca.pem'

/**
 * In-container path of the combined trust bundle `{public roots} ∪ {proxy
 * CA}` (the ConfigMap's second key). The own-bundle tools that ignore
 * SSL_CERT_FILE point their single-file vars here. See
 * docs/nested-ca-combined-bundle.md.
 */
export const PROXY_CA_BUNDLE_PATH = '/etc/yaac/certs/ca-bundle.pem'

export interface ProxyClientConfig {
  image: string
  requirePrebuilt?: boolean
}

export class ProxyClient {
  private running = false
  private authSecret: string | null = null
  private readonly forward = new ServicePortForward(PROXY_APP_NAME, PROXY_PORT)
  // In-flight ensureRunning() promise used as a mutex so concurrent
  // callers (e.g. two parallel session creates) don't race into two
  // parallel bootstrap passes.
  private ensureInflight: Promise<void> | null = null

  constructor(private config: ProxyClientConfig) {}

  /**
   * Server-side base URL: a loopback `kubectl port-forward` into the
   * Service. The proxy itself is reachable only inside the cluster.
   */
  private get baseUrl(): string {
    const port = this.forward.currentPort
    if (!port) throw new Error('Proxy not started — call ensureRunning() first')
    return `http://127.0.0.1:${port}`
  }

  private requireAuthSecret(): string {
    if (!this.authSecret) throw new Error('Proxy not started — call ensureRunning() first')
    return this.authSecret
  }

  /**
   * CA-trust (and prompt-suppression) env for session containers. No
   * routing vars: egress interception is transparent — the pod's
   * redirect init container DNATs outbound 443/80 to the proxy at the
   * network layer, so `HTTP(S)_PROXY`/`NO_PROXY` cooperation is gone and
   * tools that ignore proxy env vars are intercepted all the same. Only
   * trust in the MITM CA still needs to ride env.
   *
   * Two trust shapes, by what each tool reads:
   *  - ADDITIVE (proxy CA alongside the image's real roots): SSL_CERT_FILE
   *    for OpenSSL-default tooling and NODE_EXTRA_CA_CERTS for Node, which
   *    keep consulting the default store/bundled roots too.
   *  - REPLACE (single-file bundle): CURL_CA_BUNDLE / REQUESTS_CA_BUNDLE /
   *    CARGO_HTTP_CAINFO / GIT_SSL_CAINFO for the own-bundle tools (curl,
   *    requests, cargo, git-libcurl) that ignore SSL_CERT_FILE. Pointing
   *    those at the lone proxy CA would make them reject the real cert of
   *    every tunnelled host, so they get the combined bundle (roots + CA) —
   *    a superset, which makes "replace" correct on both intercepted and
   *    tunnelled hosts. See docs/nested-ca-combined-bundle.md.
   */
  getCaTrustEnv(): string[] {
    return [
      `NODE_EXTRA_CA_CERTS=${PROXY_CA_PATH}`,
      `SSL_CERT_FILE=${PROXY_CA_PATH}`,
      `CURL_CA_BUNDLE=${PROXY_CA_BUNDLE_PATH}`,
      `REQUESTS_CA_BUNDLE=${PROXY_CA_BUNDLE_PATH}`,
      `CARGO_HTTP_CAINFO=${PROXY_CA_BUNDLE_PATH}`,
      `GIT_SSL_CAINFO=${PROXY_CA_BUNDLE_PATH}`,
      'GIT_TERMINAL_PROMPT=0',
    ]
  }

  async getCaCert(): Promise<string> {
    const res = await fetch(`${this.baseUrl}/ca.pem`)
    if (!res.ok) throw new Error(`Failed to fetch CA cert: ${res.status}`)
    return res.text()
  }

  /**
   * The combined trust bundle `{public roots} ∪ {proxy CA}`, built by the
   * proxy from its own ca-certificates plus the MITM CA. Mounted into nested
   * containers (and the session pod) so the own-bundle tools that ignore
   * SSL_CERT_FILE (curl / requests / cargo / git-libcurl) can REPLACE their
   * trust set with a superset. See docs/nested-ca-combined-bundle.md.
   */
  async getCaBundle(): Promise<string> {
    const res = await fetch(`${this.baseUrl}/ca-bundle.pem`)
    if (!res.ok) throw new Error(`Failed to fetch CA bundle: ${res.status}`)
    return res.text()
  }

  async registerSession(
    sessionId: string,
    state: {
      rules: InjectionRule[]
      allowedHosts: string[]
      repoUrl?: string
      // Required: the proxy gates all agent-credential injection on the
      // registered tool — a session registered without one gets none.
      tool: 'claude' | 'codex' | 'opencode'
      // Required: the proxy keys its git-auth-failure records by the
      // session's owning project.
      projectSlug: string
      upstreamRedirects?: Record<string, UpstreamRedirect>
    },
  ): Promise<void> {
    const res = await fetch(`${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.requireAuthSecret()}`,
      },
      body: JSON.stringify({
        rules: state.rules,
        allowedHosts: state.allowedHosts,
        repoUrl: state.repoUrl,
        tool: state.tool,
        projectSlug: state.projectSlug,
        upstreamRedirects: state.upstreamRedirects,
      }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed to register session: ${res.status} ${text}`)
    }
  }

  /**
   * Push the full `{ podIP: outerSessionId }` attribution map for every managed
   * vcluster's pods (yaac-in-yaac). The outer proxy can't resolve these
   * cross-namespace source pods to a session itself, so chained egress (an inner
   * proxy's upstream dials, and synced pods before an inner yaac opts in) would
   * otherwise fail closed. Full-replace each call — the server sends the
   * complete current set each background tick, so a torn-down pod's IP is
   * evicted on the next push.
   */
  async registerVclusterAttribution(podSessions: Record<string, string>): Promise<void> {
    const res = await fetch(`${this.baseUrl}/vcluster-attribution`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.requireAuthSecret()}`,
      },
      body: JSON.stringify(podSessions),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed to register vcluster attribution: ${res.status} ${text}`)
    }
  }

  async removeSession(sessionId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${this.requireAuthSecret()}` },
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed to remove session: ${res.status} ${text}`)
    }
  }

  /**
   * Live-widen a running session's egress allowlist by one host (the webapp
   * "allow blocked host" action). Takes effect immediately — the proxy pushes
   * the host into its in-memory allowlist and prunes it from the recorded
   * blocked set. Returns false when the proxy has no registration for the
   * session (its 404) — the caller decides whether that matters: a project-wide
   * fan-out tolerates it, a single-session allow should surface it. Any other
   * non-OK status throws.
   */
  async allowHost(sessionId: string, host: string): Promise<boolean> {
    const res = await fetch(
      `${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/allow-host`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.requireAuthSecret()}`,
        },
        body: JSON.stringify({ host }),
      },
    )
    if (res.status === 404) return false
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed to allow host: ${res.status} ${text}`)
    }
    return true
  }

  /**
   * Attach to an already-deployed proxy without bootstrapping anything.
   * Returns true if the proxy answers /healthz through a fresh tunnel,
   * false otherwise. Used by cleanup paths that want to talk to the proxy
   * only if it already exists — they must not build images or apply
   * manifests.
   */
  async attachIfRunning(): Promise<boolean> {
    if (this.running) {
      try {
        const res = await fetch(`${this.baseUrl}/healthz`)
        if (res.ok) return true
      } catch {
        this.running = false
      }
    }
    try {
      const secret = await readExistingProxyAuthSecret()
      if (!secret) return false
      await this.forward.ensure()
      const res = await fetch(`${this.baseUrl}/healthz`)
      if (!res.ok) return false
      this.authSecret = secret
      this.running = true
      return true
    } catch {
      return false
    }
  }

  /**
   * Upload an SSH private key to the proxy's ssh-agent. `knownHostsEntry`
   * is required so the proxy can populate its known_hosts before invoking
   * `ssh-add -h <host>` — without it ssh-add can't encode the destination
   * constraint and fails with "No host keys for destination".
   */
  async uploadSshKey(host: string, keyPath: string, knownHostsEntry: string): Promise<void> {
    const keyPem = await fs.readFile(keyPath, 'utf8')
    const res = await fetch(`${this.baseUrl}/agent/keys`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.requireAuthSecret()}`,
      },
      body: JSON.stringify({ host, keyPem, knownHostsEntry }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed to upload ssh key for ${host}: ${res.status} ${text}`)
    }
  }

  /** Clear every identity from the proxy's ssh-agent. */
  async clearSshKeys(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/agent/keys`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${this.requireAuthSecret()}` },
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed to clear ssh keys: ${res.status} ${text}`)
    }
  }

  /** List identities currently loaded into the proxy's ssh-agent. */
  async listAgentKeys(): Promise<Array<{ fingerprint: string; comment: string }>> {
    const res = await fetch(`${this.baseUrl}/agent/keys`, {
      headers: { 'Authorization': `Bearer ${this.requireAuthSecret()}` },
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed to list ssh keys: ${res.status} ${text}`)
    }
    return res.json() as Promise<Array<{ fingerprint: string; comment: string }>>
  }

  /**
   * Clear-and-reload every SSH entry from the on-disk credentials file into
   * the proxy's ssh-agent. Idempotent. Called from ensureRunning() after the
   * proxy is healthy (handles cold start + agent identity loss on restart)
   * and from auth-update handlers when credentials change.
   *
   * Failures uploading individual keys are logged but don't abort the loop —
   * a broken key shouldn't prevent the others from loading.
   */
  async syncSshKeysFromCredentials(): Promise<void> {
    if (!this.running) return
    const entries = await listSshEntries()
    await this.clearSshKeys()
    for (const entry of entries) {
      try {
        await this.uploadSshKey(entry.host, entry.privateKeyPath, entry.knownHostsEntry)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        serverLog(`[server] proxy ssh-agent: failed to load key for ${entry.host}: ${msg}`)
      }
    }
  }

  /**
   * Heal ssh-agent identity loss after a proxy pod replacement. Unlike
   * session registrations (which the proxy reloads from /data on its
   * own), agent identities are memory-only by design — key bytes never
   * touch the proxy filesystem — and nothing re-uploads them unless
   * ensureRunning()'s bootstrap path runs; attachIfRunning() can quietly
   * re-attach to a fresh pod without it. A replaced pod always boots
   * with a fully empty agent (partial loss is impossible), so
   * "credentials have SSH entries but the agent holds none" is the loss
   * signature; re-sync exactly then. No-op on healthy ticks and for
   * installs with no SSH remotes.
   */
  async reconcileSshKeys(): Promise<void> {
    if (!this.running) return
    const entries = await listSshEntries()
    if (entries.length === 0) return
    if ((await this.listAgentKeys()).length > 0) return
    await this.syncSshKeysFromCredentials()
  }

  /**
   * List the session ids the proxy currently has state for. Diagnostic
   * surface: e2e tests use it to assert a replaced proxy pod actually
   * reloaded its registrations from /data (registrations are
   * write-through persisted, so nothing re-registers them at runtime).
   */
  async listSessions(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/sessions`, {
      headers: { 'Authorization': `Bearer ${this.requireAuthSecret()}` },
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed to list proxy sessions: ${res.status} ${text}`)
    }
    return res.json() as Promise<string[]>
  }

  async ensureRunning(): Promise<void> {
    if (this.ensureInflight) return this.ensureInflight
    this.ensureInflight = this.ensureRunningImpl().finally(() => {
      this.ensureInflight = null
    })
    return this.ensureInflight
  }

  private async ensureRunningImpl(): Promise<void> {
    // Fast path: already verified in this process. Gated on the deployed
    // image still matching the current proxy source — attachIfRunning()
    // (background reconciles, cleanup) marks a pre-existing proxy running
    // without ever looking at its image, so without this check a
    // healthy-but-outdated proxy would never pick up new k8s/proxy code.
    // On mismatch, fall through to the full bootstrap: it rebuilds the
    // image under its fresh content-hash tag and re-applies the
    // Deployment, whose Recreate strategy swaps the pod.
    if (this.running) {
      try {
        const res = await fetch(`${this.baseUrl}/healthz`)
        if (res.ok) {
          if (await this.isDeployedImageCurrent()) return
          serverLog('[server] proxy image is stale — rebuilding and redeploying')
        }
      } catch {
        this.running = false
      }
    }

    await ensureNamespace()
    this.authSecret = await ensureProxyAuthSecret()

    const imageRef = await this.ensureProxyImage()
    // Nested (inner) yaac: the proxy runs in a vcluster — unpinned Service +
    // the inner-proxy role label (see ensureProxyResources).
    await ensureProxyResources(imageRef, { nested: env.nested })

    await this.forward.ensure()
    await this.waitForHealthy()
    this.running = true

    // Distribute the proxy's CA to session pods via the ConfigMap: the bare
    // CA (additive trust) plus the combined bundle (roots + CA) the
    // own-bundle tools point CURL_CA_BUNDLE & friends at. Cheap no-op when
    // both stored values already match.
    const caPem = await this.getCaCert()
    const caBundle = await this.getCaBundle()
    await ensureCaConfigMap(caPem, caBundle)

    // Load ssh-agent identities (cold start: agent is empty; restart:
    // re-sync in case the proxy pod was replaced out-of-band).
    this.syncSshKeysFromCredentials().catch((err: Error) => {
      serverLog(`[server] proxy ssh-agent sync failed: ${err.message}`)
    })
  }

  /**
   * True when the deployed proxy Deployment's image matches the current
   * content hash of the proxy source (the tag encodes the build
   * context's hash — see resolveProxyImageTag). A missing Deployment
   * counts as stale so the bootstrap recreates it. kubectl errors count
   * as current: the caller is on the fast path with a demonstrably
   * healthy proxy, and falling through to a bootstrap would just fail on
   * the same broken kubectl.
   */
  async isDeployedImageCurrent(): Promise<boolean> {
    try {
      const expected = registryRef(await resolveProxyImageTag(this.config.image))
      const deployment = await kubectlGetJson<{
        spec?: { template?: { spec?: { containers?: Array<{ image?: string }> } } }
      }>(['get', 'deployment', PROXY_APP_NAME, '-n', k8sNamespace()])
      return deployment?.spec?.template?.spec?.containers?.[0]?.image === expected
    } catch {
      return true
    }
  }

  /**
   * Ensure the proxy image (content-hash tagged) exists in the registry
   * and return its in-cluster ref. Builds locally with podman only when
   * the registry doesn't already hold the tag.
   */
  private async ensureProxyImage(): Promise<string> {
    const hash = await contextHash(PROXY_DIR)
    const localTag = `${this.config.image}:${hash}`
    if (await registryHasTag(localTag)) return registryRef(localTag)

    if (!await imageExists(localTag)) {
      if (this.config.requirePrebuilt) {
        throw new Error(
          `Proxy image ${localTag} is missing or stale. ` +
          'Restart the test run so the global setup can rebuild it.',
        )
      }
      serverLog(`[build] starting ${localTag} (proxy sidecar)`)
      await buildImage(localTag, path.join(PROXY_DIR, 'Dockerfile'), PROXY_DIR)
    }
    return pushImageToRegistry(localTag)
  }

  private async waitForHealthy(): Promise<void> {
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(`${this.baseUrl}/healthz`)
        if (res.ok) return
      } catch {
        // not ready yet — possibly a dead tunnel; respawn it
        await this.forward.ensure().catch(() => { /* retried below */ })
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error('Proxy did not become healthy within 15 seconds')
  }

  /**
   * Drop the server-side control tunnel without touching the deployed
   * proxy. Called from server shutdown — without it the `kubectl
   * port-forward` child outlives the server (orphaned to PID 1) and each
   * restart stacks another one.
   */
  disconnect(): void {
    this.forward.stop()
    this.running = false
  }

  /**
   * Tear down the proxy Deployment/Service and the control tunnel. Used
   * by test teardown; production servers leave the proxy deployed.
   */
  async stop(): Promise<void> {
    console.log('Stopping proxy...')
    this.forward.stop()
    try {
      await kubectlWithRetry([
        'delete', 'deployment', PROXY_APP_NAME,
        '-n', k8sNamespace(), '--ignore-not-found', '--wait=false',
      ])
      await kubectlWithRetry([
        'delete', 'service', PROXY_APP_NAME,
        '-n', k8sNamespace(), '--ignore-not-found',
      ])
    } catch {
      // cluster unreachable — nothing to stop
    }
    this.running = false
    this.authSecret = null
  }
}

async function readExistingProxyAuthSecret(): Promise<string | null> {
  const secret = await kubectlGetJson<{ data?: Record<string, string> }>([
    'get', 'secret', 'yaac-proxy-auth', '-n', k8sNamespace(),
  ])
  const encoded = secret?.data?.secret
  return encoded ? Buffer.from(encoded, 'base64').toString('utf8') : null
}

/**
 * Compute the proxy image tag without starting or building anything.
 * Useful for fingerprinting — the tag encodes the content of the proxy
 * build context.
 */
export async function resolveProxyImageTag(image = 'yaac-proxy'): Promise<string> {
  const hash = await contextHash(PROXY_DIR)
  return `${image}:${hash}`
}

// Default singleton. YAAC_PROXY_IMAGE is a test-only hook that lets the
// e2e suite point a server subprocess at pre-built test images. Unset in
// production.
export const proxyClient = new ProxyClient({
  image: testEnv.proxyImage,
  requirePrebuilt: testEnv.requirePrebuiltImages,
})
