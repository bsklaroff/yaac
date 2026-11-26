import { getBatchApi, getCoreApi } from './client'
import {
  InformerCache,
  type InformerCacheDeps,
  type MakeInformerFn,
} from './informer-cache'
import { k8sNamespace, listObjects } from './api'
import { NETD_APP_NAME } from './proxy-constants'
import {
  listWorkspaceJobs,
  listWorkspacePods,
  mapJobObject,
  mapPodObject,
  workspaceJobSelector,
  workspacePodSelector,
  type JobInfo,
  type PodInfo,
} from './pods'
import {
  EMPTY_PROXY_STATE,
  mapProxyRefreshedObject,
  mapProxyStateObject,
  proxyOutputSelector,
  type ProxyState,
} from './proxy-objects'
import { serverLog } from '#lib/log'
import type { RefreshedToolCredentials } from '@yaac/shared/types'

/**
 * Every informer the server runs: workspace pods, workspace Jobs, the two
 * objects the egress proxy reports through, and netd's pods, whose
 * addresses the stream dial and the site endpoints use. Consumers read the
 * caches and subscribe to `onDelta` instead of listing the cluster.
 */

/** Informers over workspace pods and the Jobs that own them. */
export type WorkspaceDeltaSource = 'workspace-pods' | 'workspace-jobs'
/** The proxy's outputs: its record ConfigMap (a snapshot input) and the
 *  rotations it captured (which the owners' stores have to adopt). */
type ProxyDeltaSource = 'proxy-state' | 'proxy-refreshed'
export type DeltaSource = WorkspaceDeltaSource | ProxyDeltaSource | 'netd-pods'

/**
 * A netd pod, keyed by name: a node's old and new pod overlap while one
 * replaces the other, and keying by node would let the old pod's late
 * deletion evict the new one. `live` while it runs with an address and is
 * not being deleted.
 */
interface NetdPod {
  name: string
  node: string
  ip: string
  live: boolean
}

/** Map one API Pod to a NetdPod; null without a name or a node. */
function mapNetdPod(obj: unknown): NetdPod | null {
  const p = obj as {
    metadata?: { name?: string; deletionTimestamp?: unknown }
    spec?: { nodeName?: string }
    status?: { phase?: string; podIP?: string }
  }
  if (!p.metadata?.name || !p.spec?.nodeName) return null
  const ip = p.status?.podIP ?? ''
  return {
    name: p.metadata.name,
    node: p.spec.nodeName,
    ip,
    live: p.status?.phase === 'Running' && ip !== '' && p.metadata.deletionTimestamp == null,
  }
}

/** Each node's live netd pod address. */
function liveNetdAddresses(pods: NetdPod[]): Map<string, string> {
  return new Map(pods.filter((p) => p.live).map((p) => [p.node, p.ip]))
}

interface ClusterCacheDeps {
  /** Threaded to every informer cache (tests inject fakes). */
  makeInformerFn?: MakeInformerFn
  relistIntervalMs?: number
  log?: (msg: string) => void
}

export class ClusterCache {
  private readonly pods: InformerCache<PodInfo>
  private readonly jobs: InformerCache<JobInfo>
  private readonly proxyState: InformerCache<ProxyState>
  private readonly proxyRefreshed: InformerCache<Record<string, RefreshedToolCredentials>>
  private readonly netd: InformerCache<NetdPod>
  private readonly listeners = new Set<(source: DeltaSource) => void>()
  private readonly deps: ClusterCacheDeps

  constructor(deps: ClusterCacheDeps = {}) {
    this.deps = deps
    const ns = k8sNamespace()
    this.pods = this.buildCache('workspace-pods', {
      path: `/api/v1/namespaces/${ns}/pods`,
      labelSelector: workspacePodSelector(),
      listFn: () => getCoreApi().listNamespacedPod(
        { namespace: ns, labelSelector: workspacePodSelector() }),
      mapItem: mapPodObject,
      keyOf: (p) => p.podName,
    })
    this.jobs = this.buildCache('workspace-jobs', {
      path: `/apis/batch/v1/namespaces/${ns}/jobs`,
      labelSelector: workspaceJobSelector(),
      listFn: () => getBatchApi().listNamespacedJob(
        { namespace: ns, labelSelector: workspaceJobSelector() }),
      mapItem: mapJobObject,
      keyOf: (j) => j.jobName,
    })
    // The server pre-creates these and the proxy patches them, so each
    // cache holds one object or nothing.
    this.proxyState = this.buildCache('proxy-state', {
      path: `/api/v1/namespaces/${ns}/configmaps`,
      labelSelector: proxyOutputSelector('state'),
      listFn: () => getCoreApi().listNamespacedConfigMap(
        { namespace: ns, labelSelector: proxyOutputSelector('state') }),
      mapItem: mapProxyStateObject,
      keyOf: () => 'state',
    })
    this.proxyRefreshed = this.buildCache('proxy-refreshed', {
      path: `/api/v1/namespaces/${ns}/secrets`,
      labelSelector: proxyOutputSelector('refreshed'),
      listFn: () => getCoreApi().listNamespacedSecret(
        { namespace: ns, labelSelector: proxyOutputSelector('refreshed') }),
      mapItem: mapProxyRefreshedObject,
      keyOf: () => 'refreshed',
    })
    this.netd = this.buildCache('netd-pods', {
      path: `/api/v1/namespaces/${ns}/pods`,
      labelSelector: `app=${NETD_APP_NAME}`,
      listFn: () => getCoreApi().listNamespacedPod({ namespace: ns, labelSelector: `app=${NETD_APP_NAME}` }),
      mapItem: mapNetdPod,
      keyOf: (p) => p.name,
    })
  }

  start(): void {
    this.pods.start()
    this.jobs.start()
    this.proxyState.start()
    this.proxyRefreshed.start()
    this.netd.start()
  }

  stop(): void {
    this.pods.stop()
    this.jobs.stop()
    this.proxyState.stop()
    this.proxyRefreshed.stop()
    this.netd.stop()
  }

  /** Subscribe to deltas (multi-listener; errors are isolated). */
  onDelta(fn: (source: DeltaSource) => void): void {
    this.listeners.add(fn)
  }

  workspacePods(projectFilter?: string): PodInfo[] {
    const all = this.pods.items()
    return projectFilter ? all.filter((p) => p.projectId === projectFilter) : all
  }

  workspaceJobs(): JobInfo[] {
    return this.jobs.items()
  }

  /** What the proxy has recorded — empty until (or unless) it has written. */
  proxyRecords(): ProxyState {
    return this.proxyState.items()[0] ?? EMPTY_PROXY_STATE
  }

  /** The rotations the proxy captured and the owner's store may not hold
   *  yet, by owner. */
  refreshedCredentials(): Record<string, RefreshedToolCredentials> {
    return this.proxyRefreshed.items()[0] ?? {}
  }

  /** Running netd pods, node name to pod address, or null while the
   *  informer is not healthy. */
  netdPods(): Map<string, string> | null {
    if (!this.netd.healthy()) return null
    return liveNetdAddresses(this.netd.items())
  }

  healthy(source: WorkspaceDeltaSource): boolean {
    if (source === 'workspace-pods') return this.pods.healthy()
    return this.jobs.healthy()
  }

  private buildCache<T>(
    source: DeltaSource,
    cfg: Pick<InformerCacheDeps<T>, 'path' | 'labelSelector' | 'listFn' | 'mapItem' | 'keyOf'>,
  ): InformerCache<T> {
    const cache = new InformerCache<T>({
      ...cfg,
      ...(this.deps.makeInformerFn ? { makeInformerFn: this.deps.makeInformerFn } : {}),
      ...(this.deps.relistIntervalMs !== undefined
        ? { relistIntervalMs: this.deps.relistIntervalMs } : {}),
      ...(this.deps.log ? { log: this.deps.log } : {}),
    })
    cache.onChange(() => this.emit(source))
    return cache
  }

  private emit(source: DeltaSource): void {
    for (const fn of this.listeners) {
      try {
        fn(source)
      } catch (err) {
        (this.deps.log ?? serverLog)(`[server] cluster-cache listener failed: ${String(err)}`)
      }
    }
  }
}

/**
 * The running server's cache, readable without threading it through every
 * call site. Null outside the server (the CLI, unit tests), where the
 * readers below fall back to live lists.
 */
let activeClusterCache: ClusterCache | null = null

export function setActiveClusterCache(cache: ClusterCache | null): void {
  activeClusterCache = cache
}

export function getActiveClusterCache(): ClusterCache | null {
  return activeClusterCache
}

/**
 * This install's workspace pods, optionally for one project: from the
 * running server's cache while its watch is healthy, else a live list. An
 * unhealthy cache is never read; unseeded it would look like an empty
 * cluster, and with a dropped watch it would be stale.
 */
export async function readWorkspacePods(projectId?: string): Promise<PodInfo[]> {
  const cache = activeClusterCache
  return cache?.healthy('workspace-pods')
    ? cache.workspacePods(projectId)
    : listWorkspacePods(projectId)
}

/** This install's workspace Jobs, read as `readWorkspacePods` reads pods. */
export async function readWorkspaceJobs(): Promise<JobInfo[]> {
  const cache = activeClusterCache
  return cache?.healthy('workspace-jobs') ? cache.workspaceJobs() : listWorkspaceJobs()
}

/** This install's running netd pods, node name to pod address, read as
 *  `readWorkspacePods` reads pods. */
export async function readNetdPods(): Promise<Map<string, string>> {
  const cached = activeClusterCache?.netdPods()
  if (cached) return cached
  const pods = await listObjects('v1', 'Pod', { namespace: k8sNamespace(), labelSelector: `app=${NETD_APP_NAME}` })
  return liveNetdAddresses(pods.map(mapNetdPod).filter((p): p is NetdPod => p !== null))
}
