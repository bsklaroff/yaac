/**
 * The watch of this install's pods on netd's node, which feeds its swap
 * bounds and its pressure kill, scoped to the install namespace so netd
 * needs only a namespaced Role.
 *
 * Built on `@kubernetes/client-node` informers, which handle list/watch,
 * relist on 410, and keep the object store; netd maps that store on each
 * read instead of keeping its own cache. The in-cluster config re-reads
 * the rotated ServiceAccount token, so a long-lived netd keeps its
 * credentials.
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
import { podMemoryRequestBytes, type NodePod } from 'yaac-netd/swap'

interface RawObject {
  metadata?: { name?: string; uid?: string; labels?: Record<string, string> }
  status?: { phase?: string }
  spec?: Parameters<typeof podMemoryRequestBytes>[0]
}

/**
 * Map one API Pod on netd's node to the shape the swap bound and the
 * pressure kill read; null unless it is running, since only a running pod
 * is sure to have its cgroup. A workspace carries the server's
 * `yaac.workspace-id` label (netd can't import src/).
 */
export function mapNodePod(raw: unknown): NodePod | null {
  const { metadata, status, spec } = raw as RawObject
  const name = metadata?.name
  const uid = metadata?.uid
  if (!name || !uid || status?.phase !== 'Running') return null
  const labels = metadata?.labels ?? {}
  return {
    name,
    uid,
    memoryRequestBytes: podMemoryRequestBytes(spec ?? {}),
    workspace: 'yaac.workspace-id' in labels && labels.app !== 'yaac-proxy',
  }
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

/**
 * Watch every pod of this install on one node, builders and infrastructure
 * included, for their swap bounds (swap.ts) and the pressure kill
 * (pressure.ts).
 */
export function watchNodePods(client: WatchClient, nodeName: string, onChange: () => void): () => NodePod[] {
  const { core, namespace } = client
  const fieldSelector = `spec.nodeName=${nodeName}`
  return watch(client, 'pods', { fieldSelector }, mapNodePod, onChange,
    () => core.listNamespacedPod({ namespace, fieldSelector }))
}

function watch<T>(
  client: WatchClient,
  resource: string,
  selectors: { labelSelector?: string; fieldSelector?: string },
  map: (raw: unknown) => T | null,
  onChange: () => void,
  // client-node applies the selectors to the watch only; the list needs them too.
  listFn: () => Promise<KubernetesListObject<KubernetesObject>>,
): () => T[] {
  const path = `/api/v1/namespaces/${client.namespace}/${resource}`
  // Reconnect at once: the watch request times out every 30s, and
  // client-node's informer otherwise waits a growing delay (up to 30s)
  // before reconnecting while nothing changes, holding back the next event.
  const informer = new ListWatch(path, new Watch(client.kubeConfig), listFn, false,
    selectors.labelSelector, selectors.fieldSelector, {
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
 * superviseInformer (k8s/proxy/object-watch.ts).
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
