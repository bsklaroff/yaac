/**
 * Sessions whose teardown has been issued but whose pod may not yet carry a
 * Kubernetes deletionTimestamp — the gap between `cleanupSession*` starting
 * and the `kubectl delete` landing. Marking a session here lets the display
 * path render it as "terminating…" across that gap and for deletes that
 * originate outside the UI (CLI, the stale reaper), instead of the row
 * flashing a stray `waiting` spell on its way out.
 *
 * In-memory (server-process singleton): a restart drops the marks, which is
 * fine — a genuinely terminating pod still carries its own deletionTimestamp,
 * and `pruneTerminating` clears anything stale.
 */

/** sessionId -> epoch ms when the teardown was marked. */
const marks = new Map<string, number>()

/**
 * How long a mark survives without the pod actually disappearing. A *failed*
 * detached delete leaves the pod running and the id marked forever; after this
 * the row un-greys and the stale reaper takes over. Comfortably longer than a
 * normal teardown (pod grace 5s + kubectl delete).
 */
export const TERMINATING_TTL_MS = 60_000

/** Mark a session as terminating (idempotent; does not reset the timestamp so
 *  the TTL measures from the first mark). */
export function markSessionTerminating(sessionId: string, nowMs = Date.now()): void {
  if (!sessionId) return
  if (!marks.has(sessionId)) marks.set(sessionId, nowMs)
}

/** Whether a session is currently marked terminating. */
export function isSessionTerminating(sessionId: string): boolean {
  return marks.has(sessionId)
}

/** Drop a session's mark — called when its id is reused (restart) so a fresh
 *  incarnation isn't rendered as terminating. */
export function clearSessionTerminating(sessionId: string): void {
  marks.delete(sessionId)
}

/**
 * Forget marks that are no longer meaningful: the pod is gone (teardown
 * finished — the row leaves the list on its own) or the mark has outlived the
 * TTL (a failed teardown that never removed the pod). Called once per
 * display-list build.
 */
export function pruneTerminating(livePodIds: Set<string>, nowMs = Date.now()): void {
  for (const [sessionId, markedAt] of marks) {
    if (!livePodIds.has(sessionId) || nowMs - markedAt > TERMINATING_TTL_MS) {
      marks.delete(sessionId)
    }
  }
}

/** Test helper: drop all marks. */
export function _clearTerminatingForTests(): void {
  marks.clear()
}
