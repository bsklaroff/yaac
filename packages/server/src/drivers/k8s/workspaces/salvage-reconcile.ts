import {
  getActiveClusterCache,
  isNested,
  isPrewarmed,
  listWorkspacePods,
} from '#drivers/k8s/substrate'
import { salvageJobImages } from '#drivers/k8s/images'

/**
 * Mid-workspace image salvage: run the (idempotent, self-gating) salvage
 * for each live workspace every SALVAGE_INTERVAL_MS, so a nested workspace's
 * built/pulled images land in the project's registry WHILE the
 * workspace is alive. Teardown then only ships the delta since the last
 * run — the multi-GB first salvage of a project's base chain happens in
 * the background instead of blocking termination.
 *
 * Only nested workspaces are visited: a workspace with no in-pod engine has
 * no images of its own, and the survey it would be sent is one this side
 * already knows the answer to. The in-pod gate still stands behind this
 * (image-promoter.ts) — it is what makes the teardown salvage safe on the
 * same pods — but a probe that can only ever report nothing should not be
 * a standing per-workspace exec every interval.
 *
 * Cost when there is nothing to do: one exec per NESTED workspace per
 * interval (the in-pod survey reports no-op when every image is already in
 * the registry).
 */
export const SALVAGE_INTERVAL_MS = 10 * 60_000

/** Last salvage attempt per workspace id — module state, pruned against
 *  the live pod set each tick so it can't leak. */
const lastAttemptMs = new Map<string, number>()

/** Test-only: reset the per-workspace throttle state. */
export function _resetSalvageReconcileForTests(): void {
  lastAttemptMs.clear()
}

/**
 * One reconcile pass: pick the workspaces whose interval elapsed and
 * kick their salvages (detached — a multi-minute first salvage must not
 * wedge the loop; salvageJobImages coalesces per workspace, so a
 * teardown arriving mid-run shares the same promise instead of racing).
 */
export async function reconcileImageSalvage(
  isTerminating: (workspaceId: string) => boolean,
  nowMs: number = Date.now(),
): Promise<void> {
  let pods
  try {
    pods = getActiveClusterCache()?.workspacePods() ?? await listWorkspacePods()
  } catch {
    return
  }

  const live = new Set<string>()
  for (const p of pods) {
    if (!p.running || !p.workspaceId || !p.projectId || isPrewarmed(p)) continue
    if (!isNested(p)) continue
    if (p.terminating || isTerminating(p.workspaceId)) continue
    live.add(p.workspaceId)
    const last = lastAttemptMs.get(p.workspaceId)
    if (last !== undefined && nowMs - last < SALVAGE_INTERVAL_MS) continue
    lastAttemptMs.set(p.workspaceId, nowMs)
    void salvageJobImages({
      jobName: p.jobName,
      project: { slug: p.projectSlug, id: p.projectId },
      workspaceId: p.workspaceId,
    }).catch(() => { /* logged inside; teardown salvage retries */ })
  }

  for (const workspaceId of lastAttemptMs.keys()) {
    if (!live.has(workspaceId)) lastAttemptMs.delete(workspaceId)
  }
}
