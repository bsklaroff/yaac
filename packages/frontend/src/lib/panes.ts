/**
 * Which panes a workspace has — a question about the snapshot, where
 * `#lib/layout` is about how panes are arranged.
 *
 * Three places ask it and they have to agree, because a disagreement is a pane
 * left mounted with nothing behind it: the window sync (which panes the layout
 * should hold), the eager warm-up (which pane to pre-attach after a reload),
 * and the keep-alive set (which mounted panes are still real). An `acp`
 * workspace is where they can differ, because what looks like its agent pane is
 * really acpd's log.
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
 * The pane a workspace opens with. A `tui` workspace attaches a PTY to its agent
 * window; an `acp` one opens its first conversation's chat pane. Falls back to
 * the terminal when an ACP workspace has no conversation to show — its create
 * holds until the agent has minted one, so only a handshake that outlasted
 * that wait gets here — and the window sync swaps in the chat pane as soon as
 * it appears.
 */
export function defaultPaneTarget(workspace: WorkspaceListEntry | undefined): string {
  return acpPaneTargets(workspace)[0] ?? 'agent'
}

/**
 * Whether a pane the webapp is holding open is still one this workspace has.
 *
 * Only the agent-side targets can go stale this way — a terminal's window is
 * the terminals poll's business, and preview/changes panes are the user's — so
 * both answers here are about ACP, and both matter because these panes are
 * kept mounted while off-screen rather than torn down.
 *
 *  - A conversation that has ENDED is gone, not merely hidden. Nothing else
 *    would take its pane down, and it would sit there retrying a socket the
 *    server refuses for as long as the workspace lives.
 *  - An ACP workspace has no `agent` pane at all: that window runs acpd, so a
 *    PTY on it shows a supervisor's log rather than a conversation. One can
 *    still get opened, because an ACP workspace whose handshake outlasted its
 *    create is in the snapshot before its agent mints a conversation id —
 *    until then the warm-up has nothing else to reach for.
 */
export function paneStillLive(workspace: WorkspaceListEntry, target: string): boolean {
  const acp = acpPaneTargets(workspace)
  if (target === 'agent') return acp.length === 0
  return isAcpTarget(target) ? acp.includes(target) : true
}
