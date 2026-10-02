import { isNested, isPrewarmed, readWorkspacePods } from '#drivers/k8s/substrate'
import { salvageJobImages } from '#drivers/k8s/images'

/**
 * Periodic image salvage: every SALVAGE_INTERVAL_MS, push each live nested
 * workspace's built/pulled images to the project's registry. Teardown then
 * only ships the delta, and the large first salvage happens in the
 * background instead of blocking termination.
 *
 * Only nested workspaces are visited, since others have no in-pod engine
 * and no images. The in-pod gate (image-promoter.ts) still applies. With
 * nothing new, the cost is one exec per nested workspace per interval.
 */
export const SALVAGE_INTERVAL_MS = 10 * 60_000

/** Last salvage attempt per workspace id, pruned against live pods each
 *  pass. */
const lastAttemptMs = new Map<string, number>()

/** Test-only: reset the per-workspace throttle state. */
export function _resetSalvageReconcileForTests(): void {
  lastAttemptMs.clear()
}

/**
 * One reconcile pass: start salvage for workspaces whose interval elapsed.
 * Runs detached so a long first salvage cannot stall the loop;
 * salvageJobImages coalesces per workspace, so a teardown mid-run shares
 * the same promise.
 */
export async function reconcileImageSalvage(
  isTerminating: (workspaceId: string) => boolean,
  nowMs: number = Date.now(),
): Promise<void> {
  let pods
  try {
    pods = await readWorkspacePods()
  } catch {
    return
  }

  const live = new Set<string>()
  for (const p of pods) {
    if (!p.running || !p.workspaceId || isPrewarmed(p)) continue
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
