import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import type { SecretProxyRule } from '@/shared/types'
import { imageExists } from '@/lib/container/runtime'
import { PROXY_DIR } from '@/lib/project/paths'
import { contextHash } from '@/lib/container/image-builder'
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
import { daemonLog, pipeToDaemonLog } from '@/daemon/log'

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

/** Port the proxy serves on inside the cluster (fixed). */
export const PROXY_CONTAINER_PORT = String(PROXY_PORT)

/** Path inside session and proxy pods where the ssh-agent socket lives. */
export const SSH_AGENT_SOCKET_PATH = '/ssh-agent/socket'
/** Mount point inside pods for the shared agent-socket hostPath dir. */
export const SSH_AGENT_MOUNT = '/ssh-agent'

/** In-container path of the proxy CA cert (mounted from the ConfigMap). */
export const PROXY_CA_PATH = '/etc/yaac/certs/proxy-ca.pem'

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
   * DNS name session pods use to reach the proxy — the ClusterIP Service.
   * Stable across proxy pod replacements, unlike the podman-era container
   * IP that had to be re-discovered after every restart.
   */
  get serviceHost(): string {
    return `${PROXY_APP_NAME}.${k8sNamespace()}.svc`
  }

  /**
   * Daemon-side base URL: a loopback `kubectl port-forward` into the
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

  getProxyEnv(sessionId: string): string[] {
    const proxyUrl = `http://x:${sessionId}@${this.serviceHost}:${PROXY_PORT}`
    return [
      `HTTPS_PROXY=${proxyUrl}`,
      `HTTP_PROXY=${proxyUrl}`,
      `https_proxy=${proxyUrl}`,
      `http_proxy=${proxyUrl}`,
      `NODE_EXTRA_CA_CERTS=${PROXY_CA_PATH}`,
      `SSL_CERT_FILE=${PROXY_CA_PATH}`,
      `GIT_SSL_CAINFO=${PROXY_CA_PATH}`,
      'NO_PROXY=localhost,127.0.0.1,::1',
      'no_proxy=localhost,127.0.0.1,::1',
      'NODE_USE_ENV_PROXY=1',
      'NODE_OPTIONS=--disable-warning=UNDICI-EHPA',
      'GIT_TERMINAL_PROMPT=0',
      'GIT_HTTP_PROXY_AUTHMETHOD=basic',
    ]
  }

  async getCaCert(): Promise<string> {
    const res = await fetch(`${this.baseUrl}/ca.pem`)
    if (!res.ok) throw new Error(`Failed to fetch CA cert: ${res.status}`)
    return res.text()
  }

  async registerSession(
    sessionId: string,
    state: {
      rules: InjectionRule[]
      allowedHosts: string[]
      repoUrl?: string
      tool?: 'claude' | 'codex' | 'opencode'
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
        upstreamRedirects: state.upstreamRedirects,
      }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed to register session: ${res.status} ${text}`)
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
        daemonLog(`[daemon] proxy ssh-agent: failed to load key for ${entry.host}: ${msg}`)
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
    // Fast path: already verified in this process
    if (this.running) {
      try {
        const res = await fetch(`${this.baseUrl}/healthz`)
        if (res.ok) return
      } catch {
        this.running = false
      }
    }

    await ensureNamespace()
    this.authSecret = await ensureProxyAuthSecret()

    const imageRef = await this.ensureProxyImage()
    await ensureProxyResources(imageRef)

    await this.forward.ensure()
    await this.waitForHealthy()
    this.running = true

    // Distribute the proxy's CA to session pods via the ConfigMap. Cheap
    // no-op when the stored PEM already matches.
    const caPem = await this.getCaCert()
    await ensureCaConfigMap(caPem)

    // Load ssh-agent identities (cold start: agent is empty; restart:
    // re-sync in case the proxy pod was replaced out-of-band).
    this.syncSshKeysFromCredentials().catch((err: Error) => {
      daemonLog(`[daemon] proxy ssh-agent sync failed: ${err.message}`)
    })
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
      daemonLog(`[build] starting ${localTag} (proxy sidecar)`)
      await new Promise<void>((resolve, reject) => {
        const buildArgs = ['build', '-t', localTag]
        const certFile = process.env.SSL_CERT_FILE
        if (certFile && existsSync(certFile)) {
          buildArgs.push('--volume', `${certFile}:${certFile}:ro`)
          buildArgs.push('--build-arg', `SSL_CERT_FILE=${certFile}`)
        }
        buildArgs.push(PROXY_DIR)
        const child = spawn('podman', buildArgs, {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 300_000,
        })
        const prefix = `[build ${localTag}] `
        pipeToDaemonLog(child.stdout, prefix)
        pipeToDaemonLog(child.stderr, prefix)
        child.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`podman build exited with code ${code}`))
        })
        child.on('error', reject)
      })
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
   * Drop the daemon-side control tunnel without touching the deployed
   * proxy. Called from daemon shutdown — without it the `kubectl
   * port-forward` child outlives the daemon (orphaned to PID 1) and each
   * restart stacks another one.
   */
  disconnect(): void {
    this.forward.stop()
    this.running = false
  }

  /**
   * Tear down the proxy Deployment/Service and the control tunnel. Used
   * by test teardown; production daemons leave the proxy deployed.
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
// e2e suite point a daemon subprocess at pre-built test images. Unset in
// production.
export const proxyClient = new ProxyClient({
  image: process.env.YAAC_PROXY_IMAGE ?? 'yaac-proxy',
  requirePrebuilt: process.env.YAAC_REQUIRE_PREBUILT_IMAGES === '1',
})
