/**
 * The pod and Service watches that feed netd's reconcile, both scoped to
 * the install namespace so netd needs only a namespaced Role.
 *
 * Built on `@kubernetes/client-node` informers, which handle list/watch,
 * relist on 410, and keep the object store; netd maps that store on each
 * read instead of keeping its own cache. The in-cluster config re-reads
 * the rotated ServiceAccount token, so a long-lived netd keeps its
 * credentials.
 *
 * A delete missed while a watch was down leaves a stale pod in the store,
 * but it renders no rules because it no longer has a veth in the node's
 * route table.
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

/**
 * The pods netd redirects: workspace pods, never the proxy itself (a
 * self-redirect would loop). The workspace label must match the server's
 * LABEL_WORKSPACE_ID (netd can't import src/).
 */
export const WORKSPACE_POD_SELECTOR = 'yaac.workspace-id,app!=yaac-proxy'

/** The fields netd reads off a Pod. */
export interface NetdPod {
  name: string
  namespace: string
  podIp: string
}

/** The fields netd reads off a Service. */
export interface NetdService {
  name: string
  clusterIp: string
}

interface RawObject {
  metadata?: { name?: string; namespace?: string }
  status?: { podIP?: string }
  spec?: { clusterIP?: string }
}

/**
 * Map one API Pod object to netd's shape; null when it lacks a name,
 * namespace or IP, so a half-built pod produces no rules.
 */
export function mapPod(raw: unknown): NetdPod | null {
  const { metadata, status } = raw as RawObject
  const name = metadata?.name
  const namespace = metadata?.namespace
  const podIp = status?.podIP
  if (!name || !namespace || !podIp) return null
  return { name, namespace, podIp }
}

/** Map one API Service object to netd's shape; null when unusable. */
export function mapService(raw: unknown): NetdService | null {
  const { metadata, spec } = raw as RawObject
  const name = metadata?.name
  const clusterIp = spec?.clusterIP
  if (!name || !clusterIp) return null
  return { name, clusterIp }
}

/** An in-cluster API client for one namespace. */
export interface WatchClient {
  kubeConfig: KubeConfig
  core: CoreV1Api
  namespace: string
}

/** In-cluster client from the ServiceAccount mount (token re-read). */
export function inClusterClient(namespace: string): WatchClient {
  const kubeConfig = new KubeConfig()
  kubeConfig.loadFromCluster()
  return { kubeConfig, core: kubeConfig.makeApiClient(CoreV1Api), namespace }
}

/** Watch this namespace's workspace pods; returns a reader of the store. */
export function watchPods(client: WatchClient, onChange: () => void): () => NetdPod[] {
  const { core, namespace } = client
  return watch(client, 'pods', WORKSPACE_POD_SELECTOR, mapPod, onChange,
    () => core.listNamespacedPod({ namespace, labelSelector: WORKSPACE_POD_SELECTOR }))
}

/** Watch this namespace's Services, where the proxy's ClusterIP lives. */
export function watchServices(client: WatchClient, onChange: () => void): () => NetdService[] {
  const { core, namespace } = client
  return watch(client, 'services', undefined, mapService, onChange,
    () => core.listNamespacedService({ namespace }))
}

function watch<T>(
  client: WatchClient,
  resource: string,
  labelSelector: string | undefined,
  map: (raw: unknown) => T | null,
  onChange: () => void,
  // client-node applies the selector to the watch only; the list needs it too.
  listFn: () => Promise<KubernetesListObject<KubernetesObject>>,
): () => T[] {
  const path = `/api/v1/namespaces/${client.namespace}/${resource}`
  // Reconnect at once: the watch request times out every 30s, and
  // client-node's informer otherwise waits a growing delay (up to 30s)
  // before reconnecting while nothing changes, holding back the next event.
  const informer = new ListWatch(path, new Watch(client.kubeConfig), listFn, false, labelSelector, undefined, {
    delayFn: () => Promise.resolve(),
  })
  informer.on('add', onChange)
  informer.on('update', onChange)
  informer.on('delete', onChange)
  superviseInformer(informer, resource)
  return () => informer.list().map(map).filter((item): item is T => item !== null)
}

/**
 * Run an informer for the process's lifetime. On any error other than 410
 * (including a failed initial list) client-node's informer emits `error` and
 * stops, so this restarts it with backoff. Same pattern as the proxy's
 * superviseInformer (k8s/proxy/pod-watch.ts).
 */
function superviseInformer(
  informer: Pick<Informer<KubernetesObject>, 'on' | 'start'>,
  label: string,
): void {
  let backoffMs = 1_000
  let startedAtMs = 0
  let restartTimer: NodeJS.Timeout | null = null
  const begin = (): void => {
    startedAtMs = Date.now()
    informer.start().catch((err: unknown) => { onError(err) })
  }
  const onError = (err: unknown): void => {
    // Only rapid repeat failures back off.
    if (Date.now() - startedAtMs >= 60_000) backoffMs = 1_000
    console.error(`[netd] watch ${label}: ${String(err)} — restart in ${backoffMs}ms`)
    // A failing start can both reject and emit 'error'; schedule one restart.
    if (restartTimer) return
    restartTimer = setTimeout(() => {
      restartTimer = null
      begin()
    }, backoffMs)
    backoffMs = Math.min(backoffMs * 2, 30_000)
  }
  informer.on('error', (err: unknown) => { onError(err) })
  begin()
}
