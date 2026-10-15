import { readWorkspaceJobs, readWorkspacePods } from '#drivers/k8s/substrate'
import { runtimeHandleFromPod } from './handle'
import type { RuntimeHandle, RuntimeSnapshot, StrayUnit } from '#drivers/contract'

/**
 * The k8s reconcile-pass view in contract terms: one shared view of the
 * cluster per pass. Pods and Jobs are each read from the active
 * ClusterCache when its informer is healthy, and otherwise from a one-shot
 * list (no cache in unit tests, or the watch is down), which keeps
 * destructive steps like the stale reaper from acting on a cache known to
 * be stale.
 *
 * Each read is memoized, so every step in a pass sees the same
 * point-in-time view. A failed listing stays failed for the pass (steps
 * skip) and is retried on the next one.
 */
export function createRuntimeSnapshot(resync = true): RuntimeSnapshot {
  let podsRead: ReturnType<typeof readWorkspacePods> | undefined
  let jobsRead: ReturnType<typeof readWorkspaceJobs> | undefined
  const pods = (): ReturnType<typeof readWorkspacePods> => (podsRead ??= readWorkspacePods())
  const jobs = (): ReturnType<typeof readWorkspaceJobs> => (jobsRead ??= readWorkspaceJobs())
  return {
    resync,
    async workspaces(): Promise<RuntimeHandle[]> {
      return (await pods()).map(runtimeHandleFromPod)
    },
    async strayUnits(): Promise<StrayUnit[]> {
      // Pods and Jobs come from separate informers, each with its own
      // fallback, so one may be cached and the other live. That is safe for
      // the reaper because a read that fails rejects (and stays rejected for
      // the pass) instead of resolving empty, so "could not see" never looks
      // like "nothing there". The reaper's grace window covers the skew of a
      // just-created Job whose pod is not admitted yet.
      const [livePods, allJobs] = await Promise.all([pods(), jobs()])
      const live = new Set(livePods.map((p) => p.workspaceId).filter(Boolean))
      return allJobs
        .filter((j) => !live.has(j.workspaceId))
        .map((j) => ({
          workspaceId: j.workspaceId,
          unitName: j.jobName,
          projectId: j.projectId,
          createdAtMs: j.createdAtMs,
          prewarmed: j.prewarmed,
        }))
    },
  }
}
