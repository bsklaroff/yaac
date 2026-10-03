import {
  ApiException,
  BatchV1Api,
  CoreV1Api,
  type HttpMethod,
  KubeConfig,
  KubernetesObjectApi,
  VersionApi,
  type KubernetesObject,
} from '@kubernetes/client-node'

/**
 * Lazy singletons for the API-server client, used for every read, watch
 * and write (docs/event-driven-reconcile.md). `loadFromDefault()` resolves
 * the same kubeconfig as kubectl (`KUBECONFIG`, `~/.kube/config`, or the
 * pod's service account in-cluster), so the `kubectl exec` streams talk to
 * the same cluster. One difference remains: a cluster, user or context name
 * repeated across KUBECONFIG files makes client-node throw, where kubectl
 * keeps the first.
 */
let kubeConfig: KubeConfig | null = null
let coreApi: CoreV1Api | null = null
let batchApi: BatchV1Api | null = null
let objectApi: ObjectClient | null = null
let versionApi: VersionApi | null = null

export function getKubeConfig(): KubeConfig {
  if (!kubeConfig) {
    kubeConfig = new KubeConfig()
    // With several files in KUBECONFIG, kubectl takes current-context from
    // the first file that sets it; `true` keeps client-node in step.
    kubeConfig.loadFromDefault(undefined, true)
  }
  return kubeConfig
}

export function getCoreApi(): CoreV1Api {
  return (coreApi ??= getKubeConfig().makeApiClient(CoreV1Api))
}

export function getBatchApi(): BatchV1Api {
  return (batchApi ??= getKubeConfig().makeApiClient(BatchV1Api))
}

/** Which URL `specUriPath` builds: an object's, or its kind's collection. */
type PathAction = 'read' | 'list' | 'create'

interface SendOptions {
  query?: Record<string, string>
  body?: unknown
  contentType?: string
}

const MAX_ATTEMPTS = 5

/**
 * How long to wait before retrying `err`, or null when it is not worth
 * retrying. Transient means the API server could not answer just then: a
 * dropped or refused connection (an apiserver restart), throttling (429,
 * honoring Retry-After), or an unavailable or etcd-hiccup answer. Replaying
 * any verb is safe: a replayed create or conditional patch gets a 409 and a
 * replayed delete a 404, which callers already handle.
 */
function transientDelayMs(err: unknown, attempt: number): number | null {
  const backoff = Math.min(200 * 2 ** (attempt - 1), 3200)
  if (err instanceof ApiException) {
    const message = String((err.body as { message?: unknown } | undefined)?.message ?? err.body)
    if (err.code === 429) {
      const after = Number(err.headers['retry-after'])
      return Number.isFinite(after) ? Math.min(after * 1000, 10_000) : backoff
    }
    if (err.code === 503 || err.code === 504) return backoff
    return err.code === 500 && /etcdserver|timeout|unable to handle/i.test(message) ? backoff : null
  }
  const code = (err as { code?: unknown } | undefined)?.code
  return typeof code === 'string' && /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE)$/.test(code) ? backoff : null
}

/**
 * A generic client for any kind that sends and returns raw JSON. It reuses
 * client-node's discovery (kind to URL), auth and HTTP layer, but not its
 * typed models: those serialize a body by the fields the model declares,
 * which drops a field the model renames (a NetworkPolicy rule's `from` is
 * `_from` there) or does not know yet.
 */
export class ObjectClient extends KubernetesObjectApi {
  static create(kc: KubeConfig): ObjectClient {
    const client = kc.makeApiClient(ObjectClient)
    client.setDefaultNamespace(kc)
    return client
  }

  /**
   * One request, retried a few times while the failure is transient;
   * otherwise throws `ApiException` on a non-2xx answer.
   */
  async send(
    method: HttpMethod,
    spec: KubernetesObject,
    action: PathAction,
    opts: SendOptions = {},
  ): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.sendOnce(method, spec, action, opts)
      } catch (err) {
        const delay = attempt < MAX_ATTEMPTS ? transientDelayMs(err, attempt) : null
        if (delay === null) throw err
        await new Promise((r) => setTimeout(r, delay))
      }
    }
  }

  private async sendOnce(
    method: HttpMethod,
    spec: KubernetesObject,
    action: PathAction,
    opts: SendOptions,
  ): Promise<unknown> {
    const ctx = this.configuration.baseServer.makeRequestContext(await this.specUriPath(spec, action), method)
    for (const [k, v] of Object.entries(opts.query ?? {})) ctx.setQueryParam(k, v)
    ctx.setHeaderParam('Accept', 'application/json')
    if (opts.body !== undefined) {
      ctx.setHeaderParam('Content-Type', opts.contentType ?? 'application/json')
      ctx.setBody(JSON.stringify(opts.body))
    }
    await this.configuration.authMethods.default?.applySecurityAuthentication(ctx)
    const res = await this.configuration.httpApi.send(ctx).toPromise()
    const text = await res.body.text()
    let data: unknown = text
    try {
      data = text ? JSON.parse(text) : undefined
    } catch { /* a non-JSON error body stays text */ }
    if (res.httpStatusCode < 200 || res.httpStatusCode > 299) {
      throw new ApiException(res.httpStatusCode, 'Unsuccessful HTTP Request', data, res.headers)
    }
    return data
  }
}

export function getObjectApi(): ObjectClient {
  return (objectApi ??= ObjectClient.create(getKubeConfig()))
}

export function getVersionApi(): VersionApi {
  return (versionApi ??= getKubeConfig().makeApiClient(VersionApi))
}

/** Drop the memoized config and clients (tests only). */
export function _resetK8sClientForTests(): void {
  kubeConfig = null
  coreApi = null
  batchApi = null
  objectApi = null
  versionApi = null
}
