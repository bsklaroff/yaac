import type { PendingMamaRequest, MamaResultWire } from '@yaac/shared/types'
import {
  ensureCaConfigMap,
  ensureNamespace,
  ensureProxyAuthSecret,
  ensureProxyImage as lookupProxyImage,
  ensureProxyResources,
  resetProxyClusterIpCache,
  resolveProxyImageTag,
  sweepLegacyProxySecretsFile,
} from '#drivers/k8s/cluster'
import {
  PROXY_APP_NAME,
  PROXY_PORT,
  proxyServiceHost,
  k8sNamespace,
  kubectlGetJson,
  kubectlWithRetry,
} from '#drivers/k8s/substrate'
import { registryRef } from '#drivers/k8s/container'
import { serverLog } from '#log'
import { testEnv } from '@yaac/shared/env'

/**
 * Take whatever in-worktree `yaac-mama` requests the proxy is holding.
 *
 * `attachIfRunning`, never `ensureRunning`: this must not bootstrap the
 * proxy, which deploys lazily on the first worktree create. No proxy means
 * no worktrees means nothing queued, so an absent proxy is an empty queue
 * rather than a reason to stand one up.
 */
export async function drainPendingMamaRequests(): Promise<PendingMamaRequest[]> {
  if (!await proxyClient.attachIfRunning()) return []
  return proxyClient.fetchPendingMamaRequests()
}

// --- ProxyClient ---

/** In-container path of the proxy CA cert (mounted from the ConfigMap). */
export const PROXY_CA_PATH = '/etc/yaac/certs/proxy-ca.pem'

/**
 * In-container path of the combined trust bundle `{public roots} ∪ {proxy
 * CA}` (the ConfigMap's second key). The own-bundle tools that ignore
 * SSL_CERT_FILE point their single-file vars here. See
 * docs/nested-containers.md.
 */
export const PROXY_CA_BUNDLE_PATH = '/etc/yaac/certs/ca-bundle.pem'

export interface ProxyClientConfig {
  image: string
  /**
   * Where THIS process reaches the proxy's control API, when that is not
   * where the server reaches it.
   *
   * The server dials the proxy's Service — it is a pod of the same
   * namespace, and the proxy's ingress policy admits its pod selector on
   * this port (docs/server-in-cluster.md). Nothing in production sets this.
   *
   * What does is the e2e harness, which drives the driver's own modules
   * from the HOST, where a ClusterIP names nothing: it hands in a loopback
   * origin of its own making. A resolver rather than a string because the
   * proxy pod does not exist until `ensureRunning` has applied it, so the
   * reachability cannot be established before the client is constructed.
   */
  controlOrigin?: () => Promise<string>
}

/**
 * fetch for the control tunnel, fixing the two things the bare global
 * fetch gets wrong for an exec-relay transport:
 *  - a 15s default timeout restores the deleted ServicePortForward's
 *    fail-fast: the tunnel's local listener always accepts instantly, so
 *    a wedged apiserver otherwise black-holes every proxy call for
 *    fetch's ~300s header timeout.
 *  - connection reuse across the ~5s background reconcile ticks rides
 *    the SERVER side: the proxy's API responses carry a
 *    `Keep-Alive: timeout=60` hint, which fetch's pool honors over its
 *    4s idle default (verified) — one exec relay serves many requests
 *    instead of a fresh kubectl exec + apiserver round trip per tick.
 * Deliberately the global fetch, not a custom undici dispatcher: Node's
 * fetch bundles its own undici, and a dispatcher from the npm package
 * is rejected across majors (and tests stub globalThis.fetch).
 */
const tunnelFetch = (url: string, init: RequestInit = {}): Promise<Response> =>
  fetch(url, { signal: AbortSignal.timeout(15_000), ...init })

/** The proxy's control API, at its Service — where the server dials it. */
function proxyControlOrigin(): string {
  return `http://${proxyServiceHost(k8sNamespace(), PROXY_PORT)}`
}

export class ProxyClient {
  private running = false
  /**
   * The deployed Deployment has been verified current (image content hash
   * + runtime shape) by THIS process. Once true, ensureRunning()'s fast
   * path skips the per-create `isDeployedProxyCurrent` re-check (a kubectl
   * get + a proxy-context rehash): the expected image can only change with
   * new server code, i.e. a server restart. attachIfRunning() never sets
   * it — it marks a pre-existing proxy running without inspecting it, so
   * the first ensureRunning() still performs the real check.
   */
  private deployVerifiedCurrent = false
  /**
   * The deployed proxy answers only the pre-envelope spawn queue — set by a
   * 404 from `/cmd/pending` and cleared the moment it answers again, so
   * results always go back on the queue they were drained from. Ordinary
   * between a server upgrade and the worktree launch that rolls the proxy
   * (docs/legacy-compat-shims.md).
   */
  private legacySpawnQueue = false
  private authSecret: string | null = null
  // In-flight ensureRunning() promise used as a mutex so concurrent
  // callers (e.g. two parallel worktree creates) don't race into two
  // parallel bootstrap passes.
  private ensureInflight: Promise<void> | null = null

  constructor(private config: ProxyClientConfig) {}

  /**
   * Base URL of the proxy's control API for this process — the proxy's own
   * Service, unless the caller was handed somewhere else to dial (see
   * `ProxyClientConfig.controlOrigin`).
   */
  private async controlBase(): Promise<string> {
    return this.config.controlOrigin?.() ?? proxyControlOrigin()
  }

  private requireAuthSecret(): string {
    if (!this.authSecret) throw new Error('Proxy not started — call ensureRunning() first')
    return this.authSecret
  }

  /**
   * CA-trust (and prompt-suppression) env for worktree containers. No
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
   *    tunnelled hosts. See docs/nested-containers.md.
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

  /**
   * Open the proxy's change stream (`GET /events`, NDJSON, held open).
   *
   * Deliberately the bare `fetch`, not `tunnelFetch`: that one arms a 15s
   * `AbortSignal.timeout`, which is exactly right for a request/response
   * call and fatal for a stream meant to live for the server's whole
   * lifetime. Liveness is the caller's job instead — the proxy pings, and
   * `ProxyEventStream` aborts through `signal` when the pings stop.
   */
  async openEvents(signal: AbortSignal): Promise<Response> {
    return fetch(`${await this.controlBase()}/events`, {
      signal,
      headers: { 'Authorization': `Bearer ${this.requireAuthSecret()}` },
    })
  }

  /**
   * Drain the proxy's queued in-worktree `yaac-mama` requests. A drain is a
   * claim — the proxy hands each request out exactly once and holds the
   * worktree's HTTP response open until `postMamaResults` (or its TTL).
   */
  async fetchPendingMamaRequests(): Promise<PendingMamaRequest[]> {
    const res = await tunnelFetch(`${await this.controlBase()}/cmd/pending`, {
      headers: { 'Authorization': `Bearer ${this.requireAuthSecret()}` },
    })
    // A proxy predating the command envelope serves only the spawn queue.
    // The server is upgraded before the proxy is (it rolls on the next
    // worktree launch), so this is the ordinary state of an install between
    // the two (docs/legacy-compat-shims.md).
    if (res.status === 404) {
      this.legacySpawnQueue = true
      return this.fetchLegacyPendingSpawns()
    }
    this.legacySpawnQueue = false
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed to fetch pending yaac-mama requests: ${res.status} ${text}`)
    }
    return await res.json() as PendingMamaRequest[]
  }

  /** Complete drained requests — the proxy answers the waiting pods. */
  async postMamaResults(results: MamaResultWire[]): Promise<void> {
    if (results.length === 0) return
    // Answered on the queue they were drained from: the two are never mixed,
    // since a drain sets this and the post follows it in the same pass.
    const legacy = this.legacySpawnQueue
    const path = legacy ? '/spawn/results' : '/cmd/results'
    const body = legacy
      ? results.map((r) => ({
        requestId: r.requestId,
        ok: r.ok,
        // The legacy queue answers a spawn with the new worktree's id, which
        // is exactly what `create` renders as its output.
        worktreeId: r.output,
        error: r.error,
      }))
      : results
    const res = await tunnelFetch(`${await this.controlBase()}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.requireAuthSecret()}`,
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed to post yaac-mama results: ${res.status} ${text}`)
    }
  }

  /**
   * Drain a pre-envelope proxy's spawn queue, read as the one command it
   * could express (docs/legacy-compat-shims.md).
   */
  private async fetchLegacyPendingSpawns(): Promise<PendingMamaRequest[]> {
    const res = await tunnelFetch(`${await this.controlBase()}/spawn/pending`, {
      headers: { 'Authorization': `Bearer ${this.requireAuthSecret()}` },
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed to fetch pending spawns: ${res.status} ${text}`)
    }
    const legacy = await res.json() as Array<{
      requestId: string
      worktreeId: string
      prompt?: string
      tool?: string
      model?: string
    }>
    return legacy.map((s) => ({
      requestId: s.requestId,
      worktreeId: s.worktreeId,
      command: 'create',
      args: {
        ...(s.tool !== undefined ? { tool: s.tool } : {}),
        ...(s.model !== undefined ? { model: s.model } : {}),
      },
      body: s.prompt ?? '',
    }))
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
        const res = await tunnelFetch(`${await this.controlBase()}/healthz`)
        if (res.ok) return true
      } catch {
        this.running = false
      }
    }
    try {
      const secret = await readExistingProxyAuthSecret()
      if (!secret) return false
      const res = await tunnelFetch(`${await this.controlBase()}/healthz`)
      if (!res.ok) return false
      this.authSecret = secret
      this.running = true
      return true
    } catch {
      return false
    }
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
    // Deployment still matching this build (image content hash + the
    // stamped RuntimeClass) — attachIfRunning() (background reconciles,
    // cleanup) marks a pre-existing proxy running without ever looking at
    // it, so without this check a healthy-but-outdated proxy would never
    // pick up new k8s/proxy code or a manifest-shape change. On mismatch,
    // fall through to the full bootstrap: it re-resolves the image under
    // its content-hash tag and re-applies the Deployment, whose Recreate
    // strategy swaps the pod.
    if (this.running) {
      try {
        const res = await tunnelFetch(`${await this.controlBase()}/healthz`)
        if (res.ok) {
          if (this.deployVerifiedCurrent) return
          if (await this.isDeployedProxyCurrent()) {
            this.deployVerifiedCurrent = true
            return
          }
          serverLog('[server] proxy deployment is stale (image or runtime) — redeploying')
        }
      } catch {
        this.running = false
      }
    }

    this.deployVerifiedCurrent = false
    await ensureNamespace()
    this.authSecret = await ensureProxyAuthSecret()

    const imageRef = await this.ensureProxyImage()
    await ensureProxyResources(imageRef)

    await this.waitForHealthy()
    this.running = true
    // The bootstrap just (re)applied the current manifest — no re-check
    // needed until the next process.
    this.deployVerifiedCurrent = true

    // Distribute the proxy's CA to worktree pods via the ConfigMap: the bare
    // CA (additive trust) plus the combined bundle (roots + CA) the
    // own-bundle tools point CURL_CA_BUNDLE & friends at. Cheap no-op when
    // both stored values already match.
    await ensureCaConfigMap()

    // The rollout just completed, so the old proxy — the last reader of
    // the file an older one resolved secret values from — is gone. The
    // other condition, that nothing still needs to be read OUT of it, is
    // the composition root's to answer (docs/legacy-compat-shims.md); an
    // entrypoint that composed no answer sweeps nothing.
    if (legacySecretImportPending && !await legacySecretImportPending()) {
      await sweepLegacyProxySecretsFile()
    }
  }

  /**
   * True when the deployed proxy Deployment matches what this server
   * would deploy: the image carries the current content hash of the
   * proxy source (the tag encodes the build context's hash — see
   * resolveProxyImageTag) AND the pod template carries no RuntimeClass,
   * matching the manifest builder (trusted infra runs on runc — see the
   * gvisor.ts module doc). The runtime half is what lets a
   * manifest-shape-only upgrade (gVisor on, then infra back off it)
   * converge: attachIfRunning() marks a healthy pre-existing proxy
   * running without inspecting it, and the proxy image alone can be
   * byte-identical across such an upgrade, so an image-only check would
   * keep the old pod forever. A missing Deployment counts as stale so
   * the bootstrap recreates it. kubectl errors count as current: the
   * caller is on the fast path with a demonstrably healthy proxy, and
   * falling through to a bootstrap would just fail on the same broken
   * kubectl.
   */
  async isDeployedProxyCurrent(): Promise<boolean> {
    try {
      const expected = registryRef(await resolveProxyImageTag(this.config.image))
      const deployment = await kubectlGetJson<{
        spec?: { template?: { spec?: {
          runtimeClassName?: string
          containers?: Array<{ image?: string }>
        } } }
      }>(['get', 'deployment', PROXY_APP_NAME, '-n', k8sNamespace()])
      const podSpec = deployment?.spec?.template?.spec
      // The builder (bootstrap.ts) stamps no runtimeClassName, so a stamped
      // deployment (a gVisor-era proxy) is stale and gets re-rolled.
      return podSpec?.containers?.[0]?.image === expected
        && podSpec?.runtimeClassName === undefined
    } catch {
      return true
    }
  }

  /**
   * The proxy image's in-cluster ref, under the content-hash tag this
   * source tree hashes to. A lookup, never a build: the image is
   * yaac-shipped, so `yaac cluster install` is what puts it in the
   * registry (see proxy-image.ts).
   */
  private ensureProxyImage(): Promise<string> {
    return lookupProxyImage(this.config.image)
  }

  private async waitForHealthy(): Promise<void> {
    for (let i = 0; i < 30; i++) {
      try {
        const res = await tunnelFetch(`${await this.controlBase()}/healthz`)
        if (res.ok) return
      } catch {
        // not ready yet — the Deployment is still rolling, or its Service
        // has no endpoint behind it. Both heal on the next tick.
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error('Proxy did not become healthy within 15 seconds')
  }

  /**
   * Forget that the proxy was verified running, without touching the
   * deployed proxy. Called from server shutdown, and from anywhere the
   * control API stops answering: the next call then re-verifies rather
   * than trusting a cached `running`.
   */
  disconnect(): void {
    this.running = false
  }

  /**
   * Tear down the proxy Deployment/Service and the control tunnel. Used
   * by test teardown; production servers leave the proxy deployed.
   */
  async stop(): Promise<void> {
    console.log('Stopping proxy...')
    this.running = false
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
    this.deployVerifiedCurrent = false
    this.authSecret = null
    // The Service was just deleted — a later ensure may allocate a new
    // ClusterIP, so the per-process cache must not vouch for the old one.
    resetProxyClusterIpCache()
  }
}

/**
 * Whether the legacy env import still has work to do — handed down by the
 * composition root, because a config too broken to parse is skipped by the
 * importer and only the layer that owns the overlays can say so.
 */
let legacySecretImportPending: (() => Promise<boolean>) | undefined

export function configureLegacySecretSweep(pending: () => Promise<boolean>): void {
  legacySecretImportPending = pending
}

async function readExistingProxyAuthSecret(): Promise<string | null> {
  const secret = await kubectlGetJson<{ data?: Record<string, string> }>([
    'get', 'secret', 'yaac-proxy-auth', '-n', k8sNamespace(),
  ])
  const encoded = secret?.data?.secret
  return encoded ? Buffer.from(encoded, 'base64').toString('utf8') : null
}

// Default singleton. YAAC_PROXY_IMAGE is a test-only hook that lets the
// e2e suite point a server subprocess at pre-built test images. Unset in
// production.
export const proxyClient = new ProxyClient({ image: testEnv.proxyImage })
