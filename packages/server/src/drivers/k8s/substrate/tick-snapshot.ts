import type { JobInfo, PodInfo } from './pods'
import { readWorkspaceJobs, readWorkspacePods } from './cluster-cache'

/**
 * One reconcile pass's shared view of the cluster. Each getter reads the
 * active ClusterCache when its informer is healthy, and otherwise falls
 * back to a one-shot list (no cache in unit tests, or the watch is down).
 * The fallback keeps destructive steps like the stale reaper from acting on
 * a cache known to be stale.
 *
 * Getters memoize, so every step in a pass sees the same point-in-time
 * view. A failed fallback listing stays failed for the pass (steps skip)
 * and is retried on the next one.
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
}

export function createTickSnapshot(resync = true): TickSnapshot {
  let pods: Promise<PodInfo[]> | undefined
  let jobs: Promise<JobInfo[]> | undefined
  return {
    resync,
    pods: () => (pods ??= readWorkspacePods()),
    jobs: () => (jobs ??= readWorkspaceJobs()),
  }
}
