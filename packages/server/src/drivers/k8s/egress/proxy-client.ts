import type { PendingMamaRequest, MamaResultWire } from '@yaac/shared/types'
import {
  ensureCaConfigMap,
  ensureNamespace,
  ensureProxyAuthSecret,
  ensureProxyImage as lookupProxyImage,
  ensureProxyResources,
  resetProxyClusterIpCache,
  resolveProxyImageTag,
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
 * Take whatever in-workspace `yaac-mama` requests the proxy is holding.
 * Never deploys the proxy: it deploys on the first workspace create, so no
 * proxy means no workspaces and an empty queue.
 */
export async function drainPendingMamaRequests(): Promise<PendingMamaRequest[]> {
  if (!await proxyClient.attachIfRunning()) return []
  return proxyClient.fetchPendingMamaRequests()
}

// --- ProxyClient ---

/** In-container path of the proxy CA cert (mounted from the ConfigMap). */
export const PROXY_CA_PATH = '/etc/yaac/certs/proxy-ca.pem'

/**
 * In-container path of the combined trust bundle (public roots plus the
 * proxy CA), for tools that ignore SSL_CERT_FILE. See
 * docs/nested-containers.md.
 */
export const PROXY_CA_BUNDLE_PATH = '/etc/yaac/certs/ca-bundle.pem'

export interface ProxyClientConfig {
  image: string
  /**
   * Overrides where this process reaches the proxy's control API. The
   * server dials the proxy's Service (docs/server-in-cluster.md) and never
   * sets this. The e2e harness runs on the host, where a ClusterIP is
   * unreachable, so it supplies a loopback origin. It is a function because
   * the proxy pod doesn't exist until `ensureRunning` has deployed it.
   */
  controlOrigin?: () => Promise<string>
}

/**
 * fetch for request/response calls to the proxy's control API, with a 15s
 * timeout so an unresponsive proxy fails fast instead of waiting out
 * fetch's ~300s header timeout. Uses the global fetch rather than a custom
 * undici dispatcher: Node's bundled undici rejects a dispatcher from a
 * different undici major, and tests stub globalThis.fetch.
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
   * This process has confirmed the deployed proxy matches its own build
   * (`isDeployedProxyCurrent`). The expected image only changes with a
   * server restart, so the check runs once per process. attachIfRunning()
   * never sets it, so the first ensureRunning() still checks.
   */
  private deployVerifiedCurrent = false
  private authSecret: string | null = null
  /** In-flight ensureRunning(), shared so concurrent callers run one
   *  bootstrap. */
  private ensureInflight: Promise<void> | null = null

  constructor(private config: ProxyClientConfig) {}

  private async controlBase(): Promise<string> {
    return this.config.controlOrigin?.() ?? proxyControlOrigin()
  }

  private requireAuthSecret(): string {
    if (!this.authSecret) throw new Error('Proxy not started — call ensureRunning() first')
    return this.authSecret
  }

  /**
   * CA-trust env for workspace containers. Egress interception is
   * transparent (no HTTP(S)_PROXY vars), so only trust in the proxy's CA
   * goes in env:
   *  - SSL_CERT_FILE and NODE_EXTRA_CA_CERTS get the bare proxy CA; their
   *    tools still consult the default roots too.
   *  - CURL_CA_BUNDLE, REQUESTS_CA_BUNDLE, CARGO_HTTP_CAINFO and
   *    GIT_SSL_CAINFO replace the default roots, so they get the combined
   *    bundle, or they would reject hosts the proxy tunnels untouched.
   * See docs/nested-containers.md.
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
   * Open the proxy's change stream (`GET /events`, NDJSON, held open). Uses
   * the bare `fetch`, since `tunnelFetch`'s 15s timeout would kill a
   * long-lived stream; `ProxyEventStream` aborts via `signal` when the
   * proxy's pings stop.
   */
  async openEvents(signal: AbortSignal): Promise<Response> {
    return fetch(`${await this.controlBase()}/events`, {
      signal,
      headers: { 'Authorization': `Bearer ${this.requireAuthSecret()}` },
    })
  }

  /**
   * Claim the proxy's queued in-workspace `yaac-mama` requests. Each is
   * handed out once; the proxy holds the workspace's HTTP response open
   * until `postMamaResults` answers it or its TTL expires.
   */
  async fetchPendingMamaRequests(): Promise<PendingMamaRequest[]> {
    const res = await tunnelFetch(`${await this.controlBase()}/cmd/pending`, {
      headers: { 'Authorization': `Bearer ${this.requireAuthSecret()}` },
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed to fetch pending yaac-mama requests: ${res.status} ${text}`)
    }
    return await res.json() as PendingMamaRequest[]
  }

  /** Complete drained requests — the proxy answers the waiting pods. */
  async postMamaResults(results: MamaResultWire[]): Promise<void> {
    if (results.length === 0) return
    const res = await tunnelFetch(`${await this.controlBase()}/cmd/results`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.requireAuthSecret()}`,
      },
      body: JSON.stringify(results),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed to post yaac-mama results: ${res.status} ${text}`)
    }
  }

  /**
   * Attach to an already-deployed proxy without deploying anything.
   * Returns true if its auth secret exists and it answers /healthz.
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
    // Fast path when healthy and current. attachIfRunning() marks a proxy
    // running without checking its version, so an outdated one falls
    // through to the full bootstrap, which re-applies the Deployment.
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
    this.deployVerifiedCurrent = true

    // Publish the proxy CA and combined bundle for workspace pods.
    await ensureCaConfigMap()
  }

  /**
   * True when the deployed proxy matches what this server would deploy: the
   * image has the current content-hash tag (`resolveProxyImageTag`) and the
   * pod sets no RuntimeClass (the proxy is trusted infra and runs on runc;
   * see cluster/proxy-manifests.ts). The image can be unchanged across a
   * manifest-only change, hence the second check. A missing Deployment is
   * stale. kubectl errors count as current: the proxy just answered
   * /healthz, and a bootstrap would fail on the same kubectl error.
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
      return podSpec?.containers?.[0]?.image === expected
        && podSpec?.runtimeClassName === undefined
    } catch {
      return true
    }
  }

  /**
   * The proxy image's in-cluster ref under its content-hash tag. A lookup,
   * never a build: `yaac cluster install` pushes it (cluster/proxy-image.ts).
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
        // Not ready yet: the Deployment is still rolling out.
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error('Proxy did not become healthy within 15 seconds')
  }

  /** Forget that the proxy was verified running, so the next call
   *  re-checks. Leaves the deployed proxy alone. */
  disconnect(): void {
    this.running = false
  }

  /** Delete the proxy Deployment and Service. Used by test teardown. */
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
    // A recreated Service may get a new ClusterIP.
    resetProxyClusterIpCache()
  }
}

async function readExistingProxyAuthSecret(): Promise<string | null> {
  const secret = await kubectlGetJson<{ data?: Record<string, string> }>([
    'get', 'secret', 'yaac-proxy-auth', '-n', k8sNamespace(),
  ])
  const encoded = secret?.data?.secret
  return encoded ? Buffer.from(encoded, 'base64').toString('utf8') : null
}

/** Default singleton. The image name comes from YAAC_PROXY_IMAGE, which
 *  only tests set. */
export const proxyClient = new ProxyClient({ image: testEnv.proxyImage })
