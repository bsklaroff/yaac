/**
 * Which panes a worktree has — a question about the snapshot, where
 * `#lib/layout` is about how panes are arranged.
 *
 * Three places ask it and they have to agree, because a disagreement is a pane
 * left mounted with nothing behind it: the window sync (which panes the layout
 * should hold), the eager warm-up (which pane to pre-attach after a reload),
 * and the keep-alive set (which mounted panes are still real). An `acp`
 * worktree is where they can differ, because what looks like its agent pane is
 * really acpd's log.
 */

import { acpTarget, isAcpTarget } from '@yaac/shared/acp'
import type { WorktreeListEntry } from '@yaac/shared/types'

/** The worktree's live conversations, as pane targets. */
export function acpPaneTargets(worktree: WorktreeListEntry | undefined): string[] {
  return (worktree?.agentSessions ?? [])
    .filter((a) => a.mode === 'acp' && a.active)
    .map((a) => acpTarget(a.agentSessionId))
}

/**
 * The pane a worktree opens with. A `tui` worktree attaches a PTY to its agent
 * window; an `acp` one opens its first conversation's chat pane. Falls back to
 * the terminal when a fresh ACP worktree has not reported a conversation yet
 * (its id is minted by the agent, seconds after the pod is up) — the window
 * sync swaps in the chat pane as soon as it appears.
 */
export function defaultPaneTarget(worktree: WorktreeListEntry | undefined): string {
  return acpPaneTargets(worktree)[0] ?? 'agent'
}

/**
 * Whether a pane the webapp is holding open is still one this worktree has.
 *
 * Only the agent-side targets can go stale this way — a terminal's window is
 * the terminals poll's business, and preview/changes panes are the user's — so
 * both answers here are about ACP, and both matter because these panes are
 * kept mounted while off-screen rather than torn down.
 *
 *  - A conversation that has ENDED is gone, not merely hidden. Nothing else
 *    would take its pane down, and it would sit there retrying a socket the
 *    server refuses for as long as the worktree lives.
 *  - An ACP worktree has no `agent` pane at all: that window runs acpd, so a
 *    PTY on it shows a supervisor's log rather than a conversation. One can
 *    still get opened, because a fresh ACP worktree is in the snapshot for
 *    seconds before its agent mints a conversation id — until then the warm-up
 *    has nothing else to reach for.
 */
export function paneStillLive(worktree: WorktreeListEntry, target: string): boolean {
  const acp = acpPaneTargets(worktree)
  if (target === 'agent') return acp.length === 0
  return isAcpTarget(target) ? acp.includes(target) : true
}
