import { getBatchApi, getCoreApi } from './client'
import {
  InformerCache,
  type InformerCacheDeps,
  type MakeInformerFn,
} from './informer-cache'
import { k8sNamespace } from './kubectl'
import {
  LABEL_VCLUSTER_MANAGED_BY,
  mapJobObject,
  mapPodObject,
  worktreeJobSelector,
  worktreePodSelector,
  type JobInfo,
  type PodInfo,
} from './pods'
import {
  mapVclusterConfigMapObject,
  mapVclusterNamespaceObject,
  mapVclusterPodObject,
  mapVclusterServiceObject,
  vclusterNamespaceSelector,
  type VclusterConfigMap,
  type VclusterNamespaceInfo,
  type VclusterPod,
  type VclusterService,
} from './vcluster-objects'
import { serverLog } from '#log'

/**
 * Every informer the server runs, in one registry: the install-scoped
 * worktree pods / worktree Jobs / vcluster namespaces watches, plus a
 * dynamic pods+services+claims informer set per live vcluster namespace
 * (created and torn down as the namespaces cache changes). Consumers —
 * the reconciler, the status-watcher sync, the display path — read the
 * caches and subscribe to `onDelta` instead of listing the cluster.
 */
/** The install-scoped informers: a workspace and the unit holding it. The
 *  two the layers above have their own words for, and so the two anything
 *  forwarding a delta upward has to translate. */
export const WORKSPACE_DELTA_SOURCES = ['worktree-pods', 'worktree-jobs'] as const

/** The per-vcluster informers. Nothing above the runtime has a word for
 *  these, so they travel upward unchanged. */
export const VCLUSTER_DELTA_SOURCES = [
  'vcluster-namespaces',
  'vcluster-pods',
  'vcluster-services',
  'vcluster-configmaps',
] as const

export type WorkspaceDeltaSource = typeof WORKSPACE_DELTA_SOURCES[number]
export type VclusterDeltaSource = typeof VCLUSTER_DELTA_SOURCES[number]
export type DeltaSource = WorkspaceDeltaSource | VclusterDeltaSource

export interface ClusterCacheDeps {
  /** Threaded to every informer cache (tests inject fakes). */
  makeInformerFn?: MakeInformerFn
  relistIntervalMs?: number
  log?: (msg: string) => void
}

interface VclusterInformers {
  pods: InformerCache<VclusterPod>
  services: InformerCache<VclusterService>
  /** The synced redirect-claim ConfigMaps (picked out by name). */
  configMaps: InformerCache<VclusterConfigMap>
}

export class ClusterCache {
  private readonly pods: InformerCache<PodInfo>
  private readonly jobs: InformerCache<JobInfo>
  private readonly namespaces: InformerCache<VclusterNamespaceInfo>
  private readonly vcInformers = new Map<string, VclusterInformers>()
  private readonly listeners = new Set<(source: DeltaSource) => void>()
  private readonly deps: ClusterCacheDeps
  private stopped = true

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
    this.namespaces = this.buildCache('vcluster-namespaces', {
      path: '/api/v1/namespaces',
      labelSelector: vclusterNamespaceSelector(),
      listFn: () => getCoreApi().listNamespace(
        { labelSelector: vclusterNamespaceSelector() }),
      mapItem: mapVclusterNamespaceObject,
      keyOf: (v) => v.namespace,
    })
    this.namespaces.onChange(() => this.syncVclusterInformers())
  }

  start(): void {
    this.stopped = false
    this.pods.start()
    this.jobs.start()
    this.namespaces.start()
  }

  stop(): void {
    this.stopped = true
    this.pods.stop()
    this.jobs.stop()
    this.namespaces.stop()
    for (const entry of this.vcInformers.values()) {
      entry.pods.stop()
      entry.services.stop()
      entry.configMaps.stop()
    }
    this.vcInformers.clear()
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

  vclusterNamespaces(): VclusterNamespaceInfo[] {
    return this.namespaces.items()
  }

  /** null when no healthy informer covers the namespace (caller lists live). */
  vclusterPods(namespace: string): VclusterPod[] | null {
    const entry = this.vcInformers.get(namespace)
    return entry?.pods.healthy() ? entry.pods.items() : null
  }

  /** null when no healthy informer covers the namespace (caller lists live). */
  vclusterServices(namespace: string): VclusterService[] | null {
    const entry = this.vcInformers.get(namespace)
    return entry?.services.healthy() ? entry.services.items() : null
  }

  /** null when no healthy informer covers the namespace (caller lists live). */
  vclusterConfigMaps(namespace: string): VclusterConfigMap[] | null {
    const entry = this.vcInformers.get(namespace)
    return entry?.configMaps.healthy() ? entry.configMaps.items() : null
  }

  healthy(source: 'worktree-pods' | 'worktree-jobs' | 'vcluster-namespaces'): boolean {
    if (source === 'worktree-pods') return this.pods.healthy()
    if (source === 'worktree-jobs') return this.jobs.healthy()
    return this.namespaces.healthy()
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

  /** Keep one pods+services+claims informer set per live vcluster namespace. */
  private syncVclusterInformers(): void {
    if (this.stopped) return
    const live = new Map(this.namespaces.items().map((v) => [v.namespace, v] as const))
    for (const [ns, entry] of this.vcInformers) {
      if (live.has(ns)) continue
      entry.pods.stop()
      entry.services.stop()
      entry.configMaps.stop()
      this.vcInformers.delete(ns)
    }
    for (const [ns, vc] of live) {
      if (this.vcInformers.has(ns)) continue
      const selector = `${LABEL_VCLUSTER_MANAGED_BY}=${vc.name}`
      const pods = this.buildCache<VclusterPod>('vcluster-pods', {
        path: `/api/v1/namespaces/${ns}/pods`,
        listFn: () => getCoreApi().listNamespacedPod({ namespace: ns }),
        mapItem: mapVclusterPodObject,
        keyOf: (p) => p.name,
      })
      const services = this.buildCache<VclusterService>('vcluster-services', {
        path: `/api/v1/namespaces/${ns}/services`,
        labelSelector: selector,
        listFn: () => getCoreApi().listNamespacedService(
          { namespace: ns, labelSelector: selector }),
        mapItem: mapVclusterServiceObject,
        keyOf: (s) => s.name,
      })
      // No label selector: which ConfigMap is a claim is decided by name
      // (isClaimConfigMapName), so the path does not depend on the syncer
      // propagating labels. A vcluster namespace holds a handful of them.
      const configMaps = this.buildCache<VclusterConfigMap>('vcluster-configmaps', {
        path: `/api/v1/namespaces/${ns}/configmaps`,
        listFn: () => getCoreApi().listNamespacedConfigMap({ namespace: ns }),
        mapItem: mapVclusterConfigMapObject,
        keyOf: (cm) => cm.name,
      })
      pods.start()
      services.start()
      configMaps.start()
      this.vcInformers.set(ns, { pods, services, configMaps })
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
