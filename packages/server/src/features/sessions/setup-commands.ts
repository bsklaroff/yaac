/**
 * Pure builders for the pod-side setup commands session-create runs over
 * the stream relay after the pod is Ready and streamd answers. Each string
 * is a shell command tail executed as `sh -c <cmd>` in the pod (one shell
 * pass — the same contract `containerExec` had). Kept pure so the exact
 * command text is unit-testable.
 *
 * The tool-agnostic base setup (git identity, tmux server + options,
 * streamd) lives in `session-bin/yaac-session-init`, the pod's postStart
 * hook; only the steps that need host coordination remain here.
 */
import {
  TMUX,
  initWindowCommand,
  resolveInitWindows,
  shellEscape,
  type InitWindow,
} from '#features/sessions/agent-command'
import { ServerError } from '@yaac/shared/errors'
import { AGENT_TOOLS } from '@yaac/shared/types'
import type { AgentTool, YaacConfig } from '@yaac/shared/types'

/**
 * Re-point the fresh worktree's git plumbing at in-container paths, then
 * lock it — one exec:
 *
 *  - The host-side `git worktree add` wrote host paths into the `.git`
 *    file and the admin dir's `gitdir`; inside the pod those must be
 *    /workspace and /repo/.git/worktrees/<id>.
 *  - The lock file keeps `git worktree prune` from ever reaping the
 *    worktree: its gitdir points at /workspace — valid only inside its own
 *    pod — so from the host, or any other pod sharing the /repo mount, it
 *    looks "prunable". A single prune would otherwise wipe every session's
 *    admin dir at once, breaking git in all live sessions. The lock file
 *    is checked before the prunable test, so prune skips it. Worktrees are
 *    never `git worktree remove`d (teardown rm -rf's the dirs), so the
 *    lock needs no clearing.
 */
export function buildWorktreeLinkExec(sessionId: string): string {
  const admin = `/repo/.git/worktrees/${sessionId}`
  return `echo 'gitdir: ${admin}' > /workspace/.git`
    + ` && echo '/workspace/.git' > ${admin}/gitdir`
    + ` && printf 'yaac session ${sessionId}' > ${admin}/locked`
}

/**
 * Set the session branch's upstream from INSIDE the pod, not on the host
 * at worktree-add time. A host-side rewrite of the shared /repo/.git/config
 * replaces the file's inode underneath the VM-kernel virtiofs cache that
 * every session pod reads through, and any in-pod git command racing the
 * stale window dies with "fatal: unknown error occurred while reading the
 * configuration files" until the cache expires (see addWorktree). A write
 * from inside a pod goes through that same shared cache, so every pod —
 * and the host, which reads the real filesystem — observes it coherently.
 * Must run under `withUpstreamConfigLock` (git's config lock on the shared
 * /repo/.git/config).
 */
export function buildUpstreamExec(upstreamStartPoint: string): string {
  return `git -C /workspace branch --set-upstream-to '${shellEscape(upstreamStartPoint)}'`
}

/**
 * Resolve and validate the project's init windows. Rejects every tool
 * name, not just the active tool's: a prewarmed spare can be retooled at
 * claim time, which renames the agent window to the requested tool — an
 * init window with that name would make the tmux target ambiguous.
 * Validation lives here (called before any resource is provisioned) so a
 * bad config fails the create before a worktree or Job exists.
 */
export function validateInitWindows(config: YaacConfig): InitWindow[] {
  const windows = resolveInitWindows(config)
  for (const win of windows) {
    if ((AGENT_TOOLS as readonly string[]).includes(win.name)) {
      throw new ServerError(
        'VALIDATION',
        `initCommands window name "${win.name}" collides with an agent tool window`,
      )
    }
  }
  return windows
}

/**
 * Create the init-command windows (parallel to the agent) and swap the
 * keepalive placeholder for the real agent — one exec. respawn-window -k
 * kills the `sleep infinity` the postStart hook opened the session with
 * and starts the agent in the same window, preserving the tmux options
 * configured there.
 */
export function buildWindowsExec(
  windows: InitWindow[],
  tool: AgentTool,
  agentCmd: string,
): string {
  const cmds = windows.map(initWindowCommand)
  cmds.push(`${TMUX} respawn-window -k -t yaac:${tool} '${agentCmd}'`)
  return cmds.join(' && ')
}
