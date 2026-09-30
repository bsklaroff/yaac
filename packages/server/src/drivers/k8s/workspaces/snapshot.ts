import { createTickSnapshot } from '#drivers/k8s/substrate'
import { runtimeHandleFromPod } from './handle'
import type { RuntimeHandle, RuntimeSnapshot, StrayUnit } from '#drivers/contract'

/**
 * The k8s reconcile-pass view in contract terms, built on `TickSnapshot`
 * (memoized per pass, cache with live fallback).
 */
export function createRuntimeSnapshot(resync = true): RuntimeSnapshot {
  const tick = createTickSnapshot(resync)
  return {
    resync: tick.resync,
    async workspaces(): Promise<RuntimeHandle[]> {
      return (await tick.pods()).map(runtimeHandleFromPod)
    },
    async strayUnits(): Promise<StrayUnit[]> {
      // Pods and Jobs come from separate informers, each with its own
      // fallback, so one may be cached and the other live. That is safe for
      // the reaper because a read that fails rejects (and stays rejected for
      // the pass) instead of resolving empty, so "could not see" never looks
      // like "nothing there". The reaper's grace window covers the skew of a
      // just-created Job whose pod is not admitted yet.
      const [pods, jobs] = await Promise.all([tick.pods(), tick.jobs()])
      const live = new Set(pods.map((p) => p.workspaceId).filter(Boolean))
      return jobs
        .filter((j) => !live.has(j.workspaceId))
        .map((j) => ({
          workspaceId: j.workspaceId,
          unitName: j.jobName,
          projectSlug: j.projectSlug,
          createdAtMs: j.createdAtMs,
        }))
    },
  }
}
