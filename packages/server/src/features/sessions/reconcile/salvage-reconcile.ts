import { isPrewarmed, listSessionPods } from '#platform/k8s/pods'
import { getActiveClusterCache } from '#platform/k8s/cluster-cache'
import { isSessionTerminating } from '#features/sessions/state'
import { salvageSessionImages } from '#features/images'

/**
 * Mid-session image salvage: run the (idempotent, self-gating) salvage
 * for each live session every SALVAGE_INTERVAL_MS, so a nested session's
 * built/pulled images land in the project's shared store WHILE the
 * session is alive. Teardown then only ships the delta since the last
 * run — the multi-GB first salvage of a project's base chain happens in
 * the background instead of blocking termination.
 *
 * Cost when there is nothing to do: one exec per session per interval
 * (the in-pod survey self-gates for non-nested engines and reports
 * no-op when every image is already in the store).
 */
export const SALVAGE_INTERVAL_MS = 10 * 60_000

/** Last salvage attempt per session id — module state, pruned against
 *  the live pod set each tick so it can't leak. */
const lastAttemptMs = new Map<string, number>()

/** Test-only: reset the per-session throttle state. */
export function _resetSalvageReconcileForTests(): void {
  lastAttemptMs.clear()
}

/**
 * One reconcile pass: pick the sessions whose interval elapsed and
 * kick their salvages (detached — a multi-minute first salvage must not
 * wedge the loop; salvageSessionImages coalesces per session, so a
 * teardown arriving mid-run shares the same promise instead of racing).
 */
export async function reconcileImageSalvage(
  nowMs: number = Date.now(),
): Promise<void> {
  let pods
  try {
    pods = getActiveClusterCache()?.sessionPods() ?? await listSessionPods()
  } catch {
    return
  }

  const live = new Set<string>()
  for (const p of pods) {
    if (!p.running || !p.sessionId || !p.projectSlug || isPrewarmed(p)) continue
    if (p.terminating || isSessionTerminating(p.sessionId)) continue
    live.add(p.sessionId)
    const last = lastAttemptMs.get(p.sessionId)
    if (last !== undefined && nowMs - last < SALVAGE_INTERVAL_MS) continue
    lastAttemptMs.set(p.sessionId, nowMs)
    void salvageSessionImages({
      jobName: p.jobName,
      projectSlug: p.projectSlug,
      sessionId: p.sessionId,
    }).catch(() => { /* logged inside; teardown salvage retries */ })
  }

  for (const sessionId of lastAttemptMs.keys()) {
    if (!live.has(sessionId)) lastAttemptMs.delete(sessionId)
  }
}
