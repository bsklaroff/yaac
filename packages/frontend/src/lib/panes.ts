/**
 * Which panes a workspace has, according to the snapshot and its tmux
 * windows (`#lib/layout` handles how they are arranged).
 *
 * The window sync, the warm-up after a reload and the keep-alive set all use
 * these, so they agree and no pane stays mounted with nothing behind it.
 * `acp` workspaces are the tricky case: their `agent` window runs acpd, not
 * the conversation.
 */

import { acpTarget, isAcpTarget } from '@yaac/shared/acp'
import type { WorkspaceListEntry } from '@yaac/shared/types'
import { isFilesTarget, isFileTarget } from './files'
import { addColumn, paneTargets, removeTarget, renameTargets, type PaneLayout } from './layout'
import { isPreviewTarget } from './preview'

/** The one layout target a workspace's Changes (review) pane uses. */
export const CHANGES_TARGET = 'changes'

/** Whether a layout target is the Changes pane. */
export function isChangesTarget(target: string): boolean {
  return target === CHANGES_TARGET
}

/**
 * Non-terminal panes: left out of the tmux-window sync and closed without a
 * kill confirmation (a file pane saves first, and asks only if that fails).
 * ACP chat panes count too: their tmux window runs acpd, not the
 * conversation, and they are addressed by conversation id.
 */
export function isSpecialPane(target: string): boolean {
  return isPreviewTarget(target) || isChangesTarget(target) || isFilesTarget(target)
    || isFileTarget(target) || isAcpTarget(target)
}

/** The workspace's live conversations, as pane targets. */
export function acpPaneTargets(workspace: WorkspaceListEntry | undefined): string[] {
  return (workspace?.agentSessions ?? [])
    .filter((a) => a.mode === 'acp' && a.active)
    .map((a) => acpTarget(a.agentSessionId))
}

/**
 * The pane a workspace opens with: the agent terminal for `tui`, the first
 * conversation's chat pane for `acp`. An `acp` workspace with no
 * conversation yet (a slow handshake) falls back to the terminal, and the
 * window sync swaps in the chat pane when it appears.
 */
export function defaultPaneTarget(workspace: WorkspaceListEntry | undefined): string {
  return acpPaneTargets(workspace)[0] ?? 'agent'
}

/**
 * Whether a mounted pane still exists in this workspace:
 *
 *  - An ended conversation's pane is gone; otherwise it would keep retrying
 *    a socket the server refuses.
 *  - An `acp` workspace's `agent` pane (acpd's log) is only kept while no
 *    conversation exists yet.
 *  - A terminal pane lasts while the snapshot lists its window, or while the
 *    windows are not listed yet.
 */
export function paneStillLive(workspace: WorkspaceListEntry, target: string): boolean {
  const acp = acpPaneTargets(workspace)
  if (target === 'agent') return acp.length === 0
  if (isAcpTarget(target)) return acp.includes(target)
  if (isSpecialPane(target)) return true
  return workspace.terminals?.some((t) => t.target === target) ?? true
}

/**
 * Keep one pane per live tmux window and conversation: new ones (init
 * commands, scratch shells) are appended as columns, and gone ones are
 * removed, including kills by another client and stale ids restored from
 * localStorage. Other special panes and the user's arrangement are kept.
 *
 * Once an `acp` workspace has a conversation, its `agent` pane (acpd's log)
 * hands its place to the chat pane, so panes opened beside the `agent`
 * fallback stay to the right of the chat pane that replaces it.
 */
export function syncPaneLayout(
  layout: PaneLayout,
  workspace: WorkspaceListEntry,
  terminalTargets: string[],
): PaneLayout {
  const acp = acpPaneTargets(workspace)
  const live = [...(acp.length > 0 ? [] : ['agent']), ...acp, ...terminalTargets]
  const unshown = acp.find((t) => !paneTargets(layout).includes(t))
  let next = unshown ? renameTargets(layout, 'agent', unshown) : layout
  for (const t of paneTargets(next)) {
    if (!live.includes(t) && (isAcpTarget(t) || !isSpecialPane(t))) next = removeTarget(next, t)
  }
  for (const t of live) next = addColumn(next, t)
  return next
}
