/**
 * Which panes a workspace has, according to the snapshot (`#lib/layout`
 * handles how they are arranged).
 *
 * The window sync, the warm-up after a reload and the keep-alive set all use
 * these, so they agree and no pane stays mounted with nothing behind it.
 * `acp` workspaces are the tricky case: their `agent` window runs acpd, not
 * the conversation.
 */

import { acpTarget, isAcpTarget } from '@yaac/shared/acp'
import type { WorkspaceListEntry } from '@yaac/shared/types'

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
 * Whether a mounted pane still exists in this workspace. Only agent panes
 * are checked here (terminal windows are handled by the terminals poll):
 *
 *  - An ended conversation's pane is gone; otherwise it would keep retrying
 *    a socket the server refuses.
 *  - An `acp` workspace's `agent` pane (acpd's log) is only kept while no
 *    conversation exists yet.
 */
export function paneStillLive(workspace: WorkspaceListEntry, target: string): boolean {
  const acp = acpPaneTargets(workspace)
  if (target === 'agent') return acp.length === 0
  return isAcpTarget(target) ? acp.includes(target) : true
}
