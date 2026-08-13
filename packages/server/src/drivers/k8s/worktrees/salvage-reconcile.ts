import { getActiveClusterCache, isPrewarmed, listWorktreePods } from '#drivers/k8s/substrate'
import { salvageWorktreeImages } from '#drivers/k8s/images'

/**
 * Mid-worktree image salvage: run the (idempotent, self-gating) salvage
 * for each live worktree every SALVAGE_INTERVAL_MS, so a nested worktree's
 * built/pulled images land in the project's registry WHILE the
 * worktree is alive. Teardown then only ships the delta since the last
 * run — the multi-GB first salvage of a project's base chain happens in
 * the background instead of blocking termination.
 *
 * Cost when there is nothing to do: one exec per worktree per interval
 * (the in-pod survey self-gates for non-nested engines and reports
 * no-op when every image is already in the registry).
 */
export const SALVAGE_INTERVAL_MS = 10 * 60_000

/** Last salvage attempt per worktree id — module state, pruned against
 *  the live pod set each tick so it can't leak. */
const lastAttemptMs = new Map<string, number>()

/** Test-only: reset the per-worktree throttle state. */
export function _resetSalvageReconcileForTests(): void {
  lastAttemptMs.clear()
}

/**
 * One reconcile pass: pick the worktrees whose interval elapsed and
 * kick their salvages (detached — a multi-minute first salvage must not
 * wedge the loop; salvageWorktreeImages coalesces per worktree, so a
 * teardown arriving mid-run shares the same promise instead of racing).
 */
export async function reconcileImageSalvage(
  isTerminating: (workspaceId: string) => boolean,
  nowMs: number = Date.now(),
): Promise<void> {
  let pods
  try {
    pods = getActiveClusterCache()?.worktreePods() ?? await listWorktreePods()
  } catch {
    return
  }

  const live = new Set<string>()
  for (const p of pods) {
    if (!p.running || !p.worktreeId || !p.projectSlug || isPrewarmed(p)) continue
    if (p.terminating || isTerminating(p.worktreeId)) continue
    live.add(p.worktreeId)
    const last = lastAttemptMs.get(p.worktreeId)
    if (last !== undefined && nowMs - last < SALVAGE_INTERVAL_MS) continue
    lastAttemptMs.set(p.worktreeId, nowMs)
    void salvageWorktreeImages({
      jobName: p.jobName,
      projectSlug: p.projectSlug,
      worktreeId: p.worktreeId,
    }).catch(() => { /* logged inside; teardown salvage retries */ })
  }

  for (const worktreeId of lastAttemptMs.keys()) {
    if (!live.has(worktreeId)) lastAttemptMs.delete(worktreeId)
  }
}
