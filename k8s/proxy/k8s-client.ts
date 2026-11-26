/**
 * The proxy's in-cluster API client and its informer plumbing, which the
 * object watch (object-watch.ts) runs on. The in-cluster config re-reads
 * the rotating ServiceAccount token; a token read once at startup would
 * eventually 401, and the watches would silently stop learning.
 */

import {
  CoreV1Api,
  KubeConfig,
  ListWatch,
  Watch,
  type Informer,
  type KubernetesListObject,
  type KubernetesObject,
} from '@kubernetes/client-node'

/** In-cluster API client and the namespace this proxy serves. */
interface ApiClient {
  core: CoreV1Api
  namespace: string
  kubeConfig: KubeConfig
}

let cachedClient: ApiClient | null = null

/** Memoized in-cluster client, built from the ServiceAccount mount. */
export function inClusterClient(supplied?: KubeConfig): ApiClient {
  if (cachedClient) return cachedClient
  let kubeConfig = supplied
  if (!kubeConfig) {
    kubeConfig = new KubeConfig()
    kubeConfig.loadFromCluster()
  }
  const namespace = kubeConfig.getContextObject(kubeConfig.getCurrentContext())?.namespace
  if (!namespace) {
    throw new Error('proxy: no in-cluster namespace — is the ServiceAccount mounted?')
  }
  cachedClient = { core: kubeConfig.makeApiClient(CoreV1Api), namespace, kubeConfig }
  return cachedClient
}

/** Reset the memoized client (tests only). */
export function _resetInClusterClientForTests(): void {
  cachedClient = null
}

/**
 * A client-node informer that reconnects its watch at once. The watch
 * request times out every 30s, and client-node's own informer waits a
 * growing delay (up to 30s) before reconnecting while no events arrive,
 * which would hold back a new workspace's objects as long. The watch
 * resumes from the last resourceVersion, and a real failure is an `error`
 * that superviseInformer restarts with backoff.
 */
export function makeInformer<T extends KubernetesObject>(
  kubeConfig: KubeConfig,
  path: string,
  listFn: () => Promise<KubernetesListObject<T>>,
  labelSelector?: string,
): Informer<T> {
  return new ListWatch(path, new Watch(kubeConfig), listFn, false, labelSelector, undefined, {
    delayFn: () => Promise.resolve(),
  })
}

/**
 * Run an informer for the process's lifetime. On any error other than 410
 * (including a failed initial list) client-node's informer emits `error` and
 * stops, so this restarts it with backoff. `onSeeded` fires each time the
 * initial list has been applied; the readiness probe waits for it.
 */
export function superviseInformer(
  informer: Pick<Informer<KubernetesObject>, 'on' | 'start'>,
  label: string,
  onSeeded?: () => void,
): void {
  let backoffMs = 1_000
  let startedAtMs = 0
  let restartTimer: NodeJS.Timeout | null = null
  const begin = (): void => {
    startedAtMs = Date.now()
    informer.start().then(() => { onSeeded?.() }, (err: unknown) => { onError(err) })
  }
  const onError = (err: unknown): void => {
    // Only rapid repeat failures back off.
    if (Date.now() - startedAtMs >= 60_000) backoffMs = 1_000
    console.error(`[proxy] ${label}: ${String(err)} — restart in ${backoffMs}ms`)
    // A failing start can both reject and emit 'error'; schedule one restart.
    if (restartTimer) return
    restartTimer = setTimeout(() => {
      restartTimer = null
      begin()
    }, backoffMs)
    backoffMs = Math.min(backoffMs * 2, 30_000)
  }
  informer.on('error', (err: unknown) => { onError(err) })
  informer.on('connect', () => { console.log(`[proxy] ${label}: connected`) })
  begin()
}
