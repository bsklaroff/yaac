import crypto from 'node:crypto'
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
  deleteObject,
  readObject,
  readProxyAuthSecret,
  type ObjectRef,
} from '#drivers/k8s/substrate'
import { registryRef } from '#drivers/k8s/container'
import { serverLog } from '#log'
import { testEnv } from '@yaac/shared/env'

/**
 * Whether `bearer` is the proxy's auth secret, which the proxy presents when
 * it relays a workspace's `yaac-mama` call. Read per call: calls are rare,
 * and the Secret may be created after this server starts.
 */
export async function isProxyAuthSecret(bearer: string): Promise<boolean> {
  const secret = await readProxyAuthSecret()
  if (secret === null) return false
  const a = Buffer.from(bearer)
  const b = Buffer.from(secret)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
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
   * server restart, so the check runs once per process.
   */
  private deployVerifiedCurrent = false
  /** In-flight ensureRunning(), shared so concurrent callers run one
   *  bootstrap. */
  private ensureInflight: Promise<void> | null = null

  constructor(private config: ProxyClientConfig) {}

  private async controlBase(): Promise<string> {
    return this.config.controlOrigin?.() ?? proxyControlOrigin()
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
   * Redeploy a proxy an earlier server left behind when this build would
   * deploy a different one, so an upgrade reaches running workspaces at
   * once rather than at the next launch. Deploys nothing where there is no
   * proxy yet.
   */
  async rollIfStale(): Promise<void> {
    const deployed = await readObject(proxyRef('Deployment'))
    if (!deployed || await this.isDeployedProxyCurrent()) return
    serverLog('[server] the deployed proxy is from another build; redeploying it')
    await this.ensureRunning()
  }

  async ensureRunning(): Promise<void> {
    if (this.ensureInflight) return this.ensureInflight
    this.ensureInflight = this.ensureRunningImpl().finally(() => {
      this.ensureInflight = null
    })
    return this.ensureInflight
  }

  private async ensureRunningImpl(): Promise<void> {
    // Fast path when healthy and current. An outdated proxy falls through
    // to the full bootstrap, which re-applies the Deployment.
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
    await ensureProxyAuthSecret()

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
   * stale. A failed read counts as current: the proxy just answered
   * /healthz, and a bootstrap would fail on the same API error.
   */
  async isDeployedProxyCurrent(): Promise<boolean> {
    try {
      const expected = registryRef(await resolveProxyImageTag(this.config.image))
      const deployment = await readObject<{
        spec?: { template?: { spec?: {
          runtimeClassName?: string
          containers?: Array<{ image?: string }>
        } } }
      }>(proxyRef('Deployment'))
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
      await deleteObject(proxyRef('Deployment'))
      await deleteObject(proxyRef('Service'), { wait: true })
    } catch {
      // cluster unreachable — nothing to stop
    }
    this.running = false
    this.deployVerifiedCurrent = false
    // A recreated Service may get a new ClusterIP.
    resetProxyClusterIpCache()
  }
}

function proxyRef(kind: 'Deployment' | 'Service'): ObjectRef {
  return { apiVersion: kind === 'Deployment' ? 'apps/v1' : 'v1', kind, name: PROXY_APP_NAME, namespace: k8sNamespace() }
}

/** Default singleton. The image name comes from YAAC_PROXY_IMAGE, which
 *  only tests set. */
export const proxyClient = new ProxyClient({ image: testEnv.proxyImage })
