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
    + ` && printf 'yaac worktree ${sessionId}' > ${admin}/locked`
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
 * The tmux window name for the nth agent of a worktree. The first keeps the
 * bare tool name, so every existing `yaac:<tool>` target — the prompt paste,
 * the CLI's `attach --agent`, the terminals listing — resolves exactly as
 * before no matter how many agents a worktree ends up holding. Extras are
 * `<tool>-2`, `<tool>-3`, … which is also what `isAgentWindow` matches.
 */
export function agentWindowName(tool: AgentTool, index: number): string {
  return index === 0 ? tool : `${tool}-${index + 1}`
}

/**
 * Create the init-command windows (parallel to the agents) and swap the
 * keepalive placeholder for the real agent — one exec. respawn-window -k
 * kills the `sleep infinity` the postStart hook opened the session with
 * and starts the first agent in the same window, preserving the tmux
 * options configured there.
 *
 * `agentCmds` is one entry per agent session being started, in restore
 * order: a fresh create passes one, and a restart passes whatever was live
 * when the worktree stopped. Only the first can respawn the placeholder;
 * the rest open their own windows.
 *
 * Each entry carries its own tool, because a worktree's conversations need
 * not share one: a codex conversation resumed into a claude worktree must
 * land in a `codex-2` window, not `claude-2` — the window name is what the
 * status watcher reads to pick a tool's status grammar, so a misnamed window
 * gets classified against a title format its agent never emits.
 */
export interface AgentWindowSpec {
  tool: AgentTool
  cmd: string
}

export function buildWindowsExec(
  windows: InitWindow[],
  tool: AgentTool,
  agents: AgentWindowSpec[],
): string {
  const cmds = windows.map(initWindowCommand)
  const [primary, ...extra] = agents
  // The placeholder window carries the worktree's tool name, so the primary
  // agent respawns into it whatever tool it runs. A primary whose tool
  // differs is a case restart cannot currently produce (ordinal 0 is the
  // worktree's own agent), and renaming the window would break every
  // `yaac:<tool>` target.
  cmds.push(`${TMUX} respawn-window -k -t yaac:${tool} '${primary?.cmd ?? ''}'`)
  extra.forEach((spec, i) => {
    // -d so the extra agents don't steal the active window from the primary,
    // which is what the user attaches to.
    cmds.push(`${TMUX} new-window -d -t yaac -n ${agentWindowName(spec.tool, i + 1)} '${spec.cmd}'`)
  })
  return cmds.join(' && ')
}
