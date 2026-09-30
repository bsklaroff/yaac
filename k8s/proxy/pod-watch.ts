/**
 * Maps a source pod IP to its workspace for the transparent listeners.
 *
 * netd's node-local Envoy stamps the real source pod IP in a PROXY-protocol
 * header (taken from the connection's peer address, so it can't be spoofed).
 * This module keeps a `podIP → workspaceId` index, built from each pod's
 * `yaac.workspace-id` label via a client-node informer over this namespace's
 * workspace pods. DELETED events evict IPs, so a reused IP is never
 * misattributed, and each relist evicts pods that vanished meanwhile.
 *
 * The in-cluster config re-reads the rotating ServiceAccount token. A token
 * read once at startup would eventually 401, and the index would silently
 * stop learning about new pods.
 */

import {
  CoreV1Api,
  KubeConfig,
  makeInformer,
  type Informer,
  type KubernetesObject,
} from '@kubernetes/client-node'
/**
 * Must match LABEL_WORKSPACE_ID in
 * packages/server/src/drivers/k8s/substrate/pods.ts (the proxy can't import
 * server code).
 */
export const LABEL_WORKSPACE_ID = 'yaac.workspace-id'

/** The shape we read out of a Pod object (only the fields we need). */
export interface WatchedPod {
  metadata?: { labels?: Record<string, string> }
  status?: { podIP?: string }
}

export interface PodWatchEvent {
  /** ADDED | MODIFIED | DELETED (k8s watch verbs). */
  type: string
  object: WatchedPod
}

/** workspaceId carried by a pod, or null if it has no IP / workspace label yet. */
export function podWorkspaceId(pod: WatchedPod): string | null {
  const ip = pod.status?.podIP
  const sid = pod.metadata?.labels?.[LABEL_WORKSPACE_ID]
  if (!ip || !sid) return null
  return sid
}

/**
 * In-memory `podIP → workspaceId` index, plus the reverse map the relay
 * listener uses. A DELETED event removes the reverse entry only if it still
 * points at that pod's IP, so a replacement pod's entry survives the old
 * pod's late deletion event.
 */
export class PodWorkspaceIndex {
  private byIp = new Map<string, string>()
  private byId = new Map<string, string>()

  /** Apply one watch event. ADDED/MODIFIED upsert; DELETED (or a pod that
   * lost its IP/label) evicts. */
  apply(ev: PodWatchEvent): void {
    const ip = ev.object.status?.podIP
    if (!ip) return
    const sid = podWorkspaceId(ev.object)
    if (ev.type === 'DELETED' || sid === null) {
      const evicted = this.byIp.get(ip)
      this.byIp.delete(ip)
      if (evicted !== undefined && this.byId.get(evicted) === ip) this.byId.delete(evicted)
      return
    }
    this.byIp.set(ip, sid)
    this.byId.set(sid, ip)
  }

  /** Rebuild the whole index from a pod list. */
  replaceAll(pods: WatchedPod[]): void {
    this.byIp.clear()
    this.byId.clear()
    for (const object of pods) this.apply({ type: 'ADDED', object })
  }

  /** The workspace for a pod IP. */
  resolve(ip: string): string | undefined {
    return this.byIp.get(ip)
  }

  /** Reverse lookup for the relay listener: the workspace's pod IP. */
  resolveIp(workspaceId: string): string | undefined {
    return this.byId.get(workspaceId)
  }

  set(ip: string, workspaceId: string): void {
    this.byIp.set(ip, workspaceId)
    this.byId.set(workspaceId, ip)
  }

  get size(): number {
    return this.byIp.size
  }
}

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

/** Selects every workspace pod in this namespace. */
const WORKSPACE_POD_SELECTOR = LABEL_WORKSPACE_ID

/** Keep `index` fed from an informer over this namespace's workspace pods. */
export function startPodWatch(index: PodWorkspaceIndex, client = inClusterClient()): void {
  const path = `/api/v1/namespaces/${client.namespace}/pods`
  // client-node applies the selector to the watch only; the list needs it too.
  const listFn = (): ReturnType<CoreV1Api['listNamespacedPod']> =>
    client.core.listNamespacedPod({
      namespace: client.namespace,
      labelSelector: WORKSPACE_POD_SELECTOR,
    })
  const informer = makeInformer(client.kubeConfig, path, listFn, WORKSPACE_POD_SELECTOR)

  const feed = (type: string) => (obj: KubernetesObject): void => {
    index.apply({ type, object: obj as WatchedPod })
  }
  informer.on('add', feed('ADDED'))
  informer.on('update', feed('MODIFIED'))
  informer.on('delete', feed('DELETED'))
  superviseInformer(informer, 'pod-watch')
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

/**
 * Relay cache-miss fallback, for a dial that beats the pod's watch event.
 * Looks the pod up by label, records it, and returns its IP (undefined makes
 * the relay fail closed).
 */
export async function fetchPodIpByWorkspaceId(
  index: PodWorkspaceIndex,
  workspaceId: string,
  client = inClusterClient(),
): Promise<string | undefined> {
  const list = await client.core.listNamespacedPod({
    namespace: client.namespace,
    labelSelector: `${LABEL_WORKSPACE_ID}=${workspaceId}`,
  })
  for (const pod of list.items) {
    const ip = pod.status?.podIP
    if (ip && podWorkspaceId(pod as WatchedPod) === workspaceId) {
      index.set(ip, workspaceId)
      return ip
    }
  }
  return undefined
}

/**
 * Cache-miss fallback, for a new pod's first packet that beats its watch
 * event. Looks the pod up by IP, records it, and returns its workspace
 * (undefined makes the caller fail closed).
 */
export async function fetchWorkspaceByPodIp(
  index: PodWorkspaceIndex,
  ip: string,
  client = inClusterClient(),
): Promise<string | undefined> {
  const list = await client.core.listNamespacedPod({
    namespace: client.namespace,
    labelSelector: WORKSPACE_POD_SELECTOR,
    fieldSelector: `status.podIP=${ip}`,
  })
  for (const pod of list.items) {
    const sid = podWorkspaceId(pod as WatchedPod)
    if (sid && pod.status?.podIP === ip) {
      index.set(ip, sid)
      return sid
    }
  }
  return undefined
}
