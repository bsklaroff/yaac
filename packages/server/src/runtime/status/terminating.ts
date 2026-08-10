/**
 * Worktrees whose teardown has been issued but whose pod may not yet carry a
 * Kubernetes deletionTimestamp — the gap between `cleanupWorktree*` starting
 * and the `kubectl delete` landing. Marking a worktree here lets the display
 * path render it as "terminating…" across that gap and for deletes that
 * originate outside the UI (CLI, the stale reaper), instead of the row
 * flashing a stray `waiting` spell on its way out.
 *
 * In-memory (server-process singleton): a restart drops the marks, which is
 * fine — a genuinely terminating pod still carries its own deletionTimestamp,
 * and `pruneTerminating` clears anything stale.
 *
 * `pruneTerminating` deliberately does NOT notify: it runs inside the
 * display-list build, so the build that prunes a mark already renders the
 * un-greyed row.
 */

import { notifyWorktreeListChanged } from '#notify'

/** worktreeId -> epoch ms when the teardown was marked. */
const marks = new Map<string, number>()

/**
 * How long a mark survives without the pod actually disappearing. A *failed*
 * detached delete leaves the pod running and the id marked forever; after this
 * the row un-greys and the stale reaper takes over. Comfortably longer than a
 * normal teardown (pod grace 5s + kubectl delete).
 */
export const TERMINATING_TTL_MS = 60_000

/** Mark a worktree as terminating (idempotent; does not reset the timestamp so
 *  the TTL measures from the first mark). */
export function markWorktreeTerminating(worktreeId: string, nowMs = Date.now()): void {
  if (!worktreeId) return
  if (marks.has(worktreeId)) return
  marks.set(worktreeId, nowMs)
  // A mark greys the row, so it is a snapshot input and announces itself
  // (docs/layered-server.md). Without this a CLI- or reaper-issued stop
  // showed nothing until the pod's deletionTimestamp delta landed, which
  // is the whole gap this mark exists to cover.
  notifyWorktreeListChanged()
}

/** Whether a worktree is currently marked terminating. */
export function isWorktreeTerminating(worktreeId: string): boolean {
  return marks.has(worktreeId)
}

/** Drop a worktree's mark — called when its id is reused (restart) so a fresh
 *  incarnation isn't rendered as terminating. */
export function clearWorktreeTerminating(worktreeId: string): void {
  if (marks.delete(worktreeId)) notifyWorktreeListChanged()
}

/**
 * Forget marks that are no longer meaningful: the pod is gone (teardown
 * finished — the row leaves the list on its own) or the mark has outlived the
 * TTL (a failed teardown that never removed the pod). Called once per
 * display-list build.
 */
export function pruneTerminating(livePodIds: Set<string>, nowMs = Date.now()): void {
  for (const [worktreeId, markedAt] of marks) {
    if (!livePodIds.has(worktreeId) || nowMs - markedAt > TERMINATING_TTL_MS) {
      marks.delete(worktreeId)
    }
  }
}

/** Test helper: drop all marks. */
export function _clearTerminatingForTests(): void {
  marks.clear()
}
