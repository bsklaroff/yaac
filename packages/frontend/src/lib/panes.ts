/**
 * Which panes a workspace has, according to the snapshot and its tmux
 * windows (`#lib/layout` handles how they are arranged).
 *
 * The window sync, the warm-up after a reload and the keep-alive set all use
 * these, so they agree and no pane stays mounted with nothing behind it.
 * Each open session has one pane, `session:<id>`, whichever mode it runs
 * in; `WorkspaceView` picks its renderer.
 */

import type { SessionEntry, WorkspaceListEntry } from '@yaac/shared/types'
import { isChangesTarget, isFilesTarget, isFileTarget } from './files'
import { addColumn, paneTargets, removeTarget, type PaneLayout } from './layout'
import { isPreviewTarget } from './preview'

const SESSION_PREFIX = 'session:'

/** A session's pane target. */
export function sessionTarget(sessionId: string): string {
  return `${SESSION_PREFIX}${sessionId}`
}

export function isSessionTarget(target: string): boolean {
  return target.startsWith(SESSION_PREFIX)
}

/** The session a session pane shows. */
export function sessionTargetId(target: string): string {
  return target.slice(SESSION_PREFIX.length)
}

/** The session behind a pane target, if it is one and still open. */
export function paneSession(workspace: WorkspaceListEntry | undefined, target: string): SessionEntry | undefined {
  if (!isSessionTarget(target)) return undefined
  const id = sessionTargetId(target)
  return workspace?.sessions.find((s) => s.sessionId === id)
}

/**
 * Panes the webapp keeps on its own: left out of the window sync and closed
 * without asking (a file pane saves first, and asks only if that fails).
 */
export function isSpecialPane(target: string): boolean {
  return isPreviewTarget(target) || isFilesTarget(target) || isChangesTarget(target) || isFileTarget(target)
}

/** The workspace's open sessions, as pane targets. */
export function sessionPaneTargets(workspace: WorkspaceListEntry | undefined): string[] {
  return (workspace?.sessions ?? []).map((s) => sessionTarget(s.sessionId))
}

/**
 * The pane a workspace opens with: its first session's. A workspace with
 * none opens empty, showing what it can start (`EmptyWorkspace`).
 */
export function defaultPaneTarget(workspace: WorkspaceListEntry | undefined): string | undefined {
  return sessionPaneTargets(workspace)[0]
}

/**
 * Whether a mounted pane still exists in this workspace: a session's while
 * it is open, a terminal's while the snapshot lists its window (or while
 * the windows are not listed yet), and the webapp's own always.
 */
export function paneStillLive(workspace: WorkspaceListEntry, target: string): boolean {
  if (isSessionTarget(target)) return sessionPaneTargets(workspace).includes(target)
  if (isSpecialPane(target)) return true
  return workspace.terminals?.some((t) => t.target === target) ?? true
}

/**
 * Keep one pane per open session and live tmux window: new ones (a session
 * another client opened, init commands, scratch shells) are appended as
 * columns, and gone ones are removed, including closes and kills by
 * another client and stale targets restored from localStorage. The webapp's
 * own panes and the user's arrangement are kept.
 */
export function syncPaneLayout(
  layout: PaneLayout,
  workspace: WorkspaceListEntry,
  terminalTargets: string[],
): PaneLayout {
  const live = [...sessionPaneTargets(workspace), ...terminalTargets]
  let next = layout
  for (const t of paneTargets(next)) {
    if (!live.includes(t) && !isSpecialPane(t)) next = removeTarget(next, t)
  }
  for (const t of live) next = addColumn(next, t)
  return next
}
