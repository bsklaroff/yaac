import { listWorktreeJobs, listWorktreePods, type JobInfo, type PodInfo } from './pods'
import {
  listVclusterConfigMaps,
  listVclusterNamespaces,
  listVclusterPods,
  listVclusterServices,
  type VclusterConfigMap,
  type VclusterNamespaceInfo,
  type VclusterPod,
  type VclusterService,
} from './vcluster-objects'
import { getActiveClusterCache } from './cluster-cache'

/**
 * One reconcile pass's shared view of the cluster. Each getter answers
 * from the active ClusterCache when its informer is healthy — the normal
 * case, costing nothing — and falls back to a one-shot kubectl list when
 * the cache is absent (unit tests, direct lib use) or degraded (watch
 * down). The fallback is the destructive-step safety story: the stale
 * reaper and vcluster GC never act on a cache known to be stale.
 *
 * Getters memoize per snapshot so every step in a pass sees one
 * point-in-time view; a failed fallback listing stays failed for the
 * whole pass (steps treat that as "skip"), and the next pass retries.
 */
export interface TickSnapshot {
  /**
   * True on the periodic full-resync pass (and for direct invocations
   * outside the reconciler). Steps may skip no-op work on delta passes
   * but must do their full heal when this is set.
   */
  resync: boolean
  pods(): Promise<PodInfo[]>
  jobs(): Promise<JobInfo[]>
  vclusters(): Promise<VclusterNamespaceInfo[]>
  /** Pods inside one vcluster's host namespace. */
  vclusterPods(namespace: string): Promise<VclusterPod[]>
  /** Syncer-managed Services inside one vcluster's host namespace. */
  vclusterServices(vc: Pick<VclusterNamespaceInfo, 'namespace' | 'name'>): Promise<VclusterService[]>
  /** ConfigMaps inside one vcluster's host namespace (claims live here). */
  vclusterConfigMaps(namespace: string): Promise<VclusterConfigMap[]>
}

export function createTickSnapshot(resync = true): TickSnapshot {
  const memo = new Map<string, Promise<unknown>>()
  const get = <T>(key: string, fromCache: () => T[] | null, list: () => Promise<T[]>): Promise<T[]> => {
    let p = memo.get(key) as Promise<T[]> | undefined
    if (!p) {
      const cached = fromCache()
      p = cached !== null ? Promise.resolve(cached) : list()
      memo.set(key, p)
    }
    return p
  }
  const cache = getActiveClusterCache()
  return {
    resync,
    pods: () => get('pods',
      () => (cache?.healthy('worktree-pods') ? cache.worktreePods() : null),
      () => listWorktreePods()),
    jobs: () => get('jobs',
      () => (cache?.healthy('worktree-jobs') ? cache.worktreeJobs() : null),
      () => listWorktreeJobs()),
    vclusters: () => get('vclusters',
      () => (cache?.healthy('vcluster-namespaces') ? cache.vclusterNamespaces() : null),
      () => listVclusterNamespaces()),
    vclusterPods: (namespace) => get(`vcluster-pods:${namespace}`,
      () => cache?.vclusterPods(namespace) ?? null,
      () => listVclusterPods(namespace)),
    vclusterServices: (vc) => get(`vcluster-services:${vc.namespace}`,
      () => cache?.vclusterServices(vc.namespace) ?? null,
      () => listVclusterServices(vc.namespace, vc.name)),
    vclusterConfigMaps: (namespace) => get(`vcluster-configmaps:${namespace}`,
      () => cache?.vclusterConfigMaps(namespace) ?? null,
      () => listVclusterConfigMaps(namespace)),
  }
}
