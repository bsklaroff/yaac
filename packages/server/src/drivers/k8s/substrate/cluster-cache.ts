import { getBatchApi, getCoreApi } from './client'
import {
  InformerCache,
  type InformerCacheDeps,
  type MakeInformerFn,
} from './informer-cache'
import { k8sNamespace } from './api'
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
import { serverLog } from '#log'
import type { RefreshedToolCredentials } from '@yaac/shared/types'

/**
 * Every informer the server runs: workspace pods, workspace Jobs, and the
 * two objects the egress proxy reports through. Consumers read the caches
 * and subscribe to `onDelta` instead of listing the cluster.
 */

/** Informers over workspace pods and the Jobs that own them. */
export type WorkspaceDeltaSource = 'workspace-pods' | 'workspace-jobs'
/** The proxy's outputs: its record ConfigMap (a snapshot input) and the
 *  rotations it captured (which the host store has to adopt). */
type ProxyDeltaSource = 'proxy-state' | 'proxy-refreshed'
export type DeltaSource = WorkspaceDeltaSource | ProxyDeltaSource

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
  private readonly proxyRefreshed: InformerCache<RefreshedToolCredentials>
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
  }

  start(): void {
    this.pods.start()
    this.jobs.start()
    this.proxyState.start()
    this.proxyRefreshed.start()
  }

  stop(): void {
    this.pods.stop()
    this.jobs.stop()
    this.proxyState.stop()
    this.proxyRefreshed.stop()
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

  /** The rotations the proxy captured and the host store may not hold yet. */
  refreshedCredentials(): RefreshedToolCredentials {
    return this.proxyRefreshed.items()[0] ?? {}
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
