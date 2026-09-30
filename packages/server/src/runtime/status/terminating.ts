/**
 * Workspaces whose teardown has started but whose runtime may not show it
 * yet (e.g. no pod deletionTimestamp). Marking them lets the display render
 * "terminating…" through that gap, including for stops from the CLI or the
 * stale reaper, instead of a stray `waiting` spell.
 *
 * In-memory only; a restart drops the marks, which is fine because a
 * terminating runtime reports it itself and `pruneTerminating` clears stale
 * marks. `pruneTerminating` does not notify, since it runs inside the
 * display-list build that already renders the result.
 */

import { notifyWorkspaceListChanged } from '#notify'

/** workspaceId -> epoch ms when the teardown was marked. */
const marks = new Map<string, number>()

/**
 * How long a mark lasts without the workspace disappearing. A failed
 * detached delete would otherwise leave it marked forever; after this the
 * row un-greys and the stale reaper takes over. Well above a normal
 * teardown.
 */
export const TERMINATING_TTL_MS = 60_000

/** Mark a workspace as terminating. Idempotent; keeps the first timestamp
 *  so the TTL counts from the first mark. */
export function markWorkspaceTerminating(workspaceId: string, nowMs = Date.now()): void {
  if (!workspaceId) return
  if (marks.has(workspaceId)) return
  marks.set(workspaceId, nowMs)
  // A mark changes the snapshot, so notify (docs/layered-server.md);
  // otherwise a CLI or reaper stop would show nothing until the runtime
  // reported it.
  notifyWorkspaceListChanged()
}

/** Whether a workspace is currently marked terminating. */
export function isWorkspaceTerminating(workspaceId: string): boolean {
  return marks.has(workspaceId)
}

/** Drop a workspace's mark, when its id is reused (restart) so the new
 *  one is not shown as terminating. */
export function clearWorkspaceTerminating(workspaceId: string): void {
  if (marks.delete(workspaceId)) notifyWorkspaceListChanged()
}

/**
 * Forget marks whose workspace is gone (teardown finished) or that outlived
 * the TTL (teardown failed). Called once per display-list build.
 */
export function pruneTerminating(livePodIds: Set<string>, nowMs = Date.now()): void {
  for (const [workspaceId, markedAt] of marks) {
    if (!livePodIds.has(workspaceId) || nowMs - markedAt > TERMINATING_TTL_MS) {
      marks.delete(workspaceId)
    }
  }
}

/** Test helper: drop all marks. */
export function _clearTerminatingForTests(): void {
  marks.clear()
}
