import { createTickSnapshot, type TickSnapshot } from '#platform/k8s'
import { runtimeHandleFromPod } from './handle'
import type { RuntimeHandle, RuntimeSnapshot, StrayUnit } from '#runtime/contract'

/**
 * The k8s pass view, in contract vocabulary.
 *
 * `TickSnapshot` is the substrate half — memoized per pass, answered from a
 * healthy informer and falling back to a one-shot listing, with a failed
 * listing staying failed for the whole pass. Nothing here changes that: it
 * only says what a pod and a Job MEAN above the boundary, so the reconcile
 * steps can share one instant without naming either.
 *
 * The substrate view rides along, because the runtime's OWN steps need the
 * vcluster views the contract has no vocabulary for (see `k8sSnapshotOf`).
 */
export interface K8sRuntimeSnapshot extends RuntimeSnapshot {
  /** The substrate view this was built over, for the runtime's own steps. */
  readonly tick: TickSnapshot
}

export function createRuntimeSnapshot(resync = true): K8sRuntimeSnapshot {
  const tick = createTickSnapshot(resync)
  return {
    tick,
    resync: tick.resync,
    async workspaces(): Promise<RuntimeHandle[]> {
      return (await tick.pods()).map(runtimeHandleFromPod)
    },
    async strayUnits(): Promise<StrayUnit[]> {
      // What this cross-reference is and is not:
      //
      // Each source is memoized for the pass, so every reader sees one
      // answer per source and a repeat read cannot shift the verdict
      // mid-pass. The two are NOT one view, though — pods and Jobs are
      // read through separate informers, each falling back to its own
      // one-shot listing when its informer is unseeded or disconnected, so
      // when their health differs one half can be cached and the other
      // live. That exposure is the same one the reaper had when it did
      // this cross-reference itself.
      //
      // What makes it safe for a destructive caller is the failure shape,
      // not simultaneity: a read that cannot be answered REJECTS (both
      // listings throw on anything but NotFound, and the rejection is
      // memoized for the pass) rather than resolving empty, so "I could
      // not see" never reads as "nothing is there". The reaper's grace
      // window covers the remaining skew, in which a just-created unit's
      // pod has not been admitted yet.
      const [pods, jobs] = await Promise.all([tick.pods(), tick.jobs()])
      const live = new Set(pods.map((p) => p.worktreeId).filter(Boolean))
      return jobs
        .filter((j) => !live.has(j.worktreeId))
        .map((j) => ({
          workspaceId: j.worktreeId,
          unitName: j.jobName,
          projectSlug: j.projectSlug,
          createdAtMs: j.createdAtMs,
        }))
    },
  }
}

/**
 * Recover the substrate view from a snapshot this runtime created.
 *
 * Honest rather than lax: the runtime's own reconcile steps are handed the
 * neutral snapshot but run inside the runtime that built it, so this is a
 * downcast to a type this module owns. It throws on a foreign snapshot
 * rather than falling back to a fresh view — silently taking a second view
 * is precisely the cross-instant read a shared pass exists to prevent.
 */
export function k8sSnapshotOf(snapshot: RuntimeSnapshot): TickSnapshot {
  const tick = (snapshot as Partial<K8sRuntimeSnapshot>).tick
  if (!tick) throw new Error('snapshot was not created by the k8s runtime')
  return tick
}
