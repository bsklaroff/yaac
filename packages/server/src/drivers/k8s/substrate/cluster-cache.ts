import { getBatchApi, getCoreApi } from './client'
import {
  InformerCache,
  type InformerCacheDeps,
  type MakeInformerFn,
} from './informer-cache'
import { k8sNamespace } from './kubectl'
import {
  mapJobObject,
  mapPodObject,
  worktreeJobSelector,
  worktreePodSelector,
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
 * Every informer the server runs, in one registry: the install-scoped
 * worktree pods and worktree Jobs watches, and the two objects the egress
 * proxy reports through. Consumers — the reconciler, the status-watcher
 * sync, the display path — read the caches and subscribe to `onDelta`
 * instead of listing the cluster.
 */
/** The install-scoped informers: a workspace and the unit holding it. The
 *  two the layers above have their own words for, and so the two anything
 *  forwarding a delta upward has to translate. */
export const WORKSPACE_DELTA_SOURCES = ['worktree-pods', 'worktree-jobs'] as const

export type WorkspaceDeltaSource = typeof WORKSPACE_DELTA_SOURCES[number]
/** The proxy's outputs: its record ConfigMap (a snapshot input) and the
 *  rotations it captured (which the host store has to adopt). */
export type ProxyDeltaSource = 'proxy-state' | 'proxy-refreshed'
export type DeltaSource = WorkspaceDeltaSource | ProxyDeltaSource

export interface ClusterCacheDeps {
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
    this.pods = this.buildCache('worktree-pods', {
      path: `/api/v1/namespaces/${ns}/pods`,
      labelSelector: worktreePodSelector(),
      listFn: () => getCoreApi().listNamespacedPod(
        { namespace: ns, labelSelector: worktreePodSelector() }),
      mapItem: mapPodObject,
      keyOf: (p) => p.podName,
    })
    this.jobs = this.buildCache('worktree-jobs', {
      path: `/apis/batch/v1/namespaces/${ns}/jobs`,
      labelSelector: worktreeJobSelector(),
      listFn: () => getBatchApi().listNamespacedJob(
        { namespace: ns, labelSelector: worktreeJobSelector() }),
      mapItem: mapJobObject,
      keyOf: (j) => j.jobName,
    })
    // One object each, selected by label: the proxy's outputs are
    // pre-created by the server and patched by the proxy, so the cache
    // holds either the one object or nothing.
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

  worktreePods(projectFilter?: string): PodInfo[] {
    const all = this.pods.items()
    return projectFilter ? all.filter((p) => p.projectSlug === projectFilter) : all
  }

  worktreeJobs(): JobInfo[] {
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
    if (source === 'worktree-pods') return this.pods.healthy()
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
 * Server-set singleton so the display path and reconcile steps can read
 * the watch-fed caches without threading the registry through every call
 * site. Null outside the server (unit tests, direct lib use) — callers
 * fall back to one-shot kubectl lists.
 */
let activeClusterCache: ClusterCache | null = null

export function setActiveClusterCache(cache: ClusterCache | null): void {
  activeClusterCache = cache
}

export function getActiveClusterCache(): ClusterCache | null {
  return activeClusterCache
}
