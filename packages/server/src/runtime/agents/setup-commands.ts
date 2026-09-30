/**
 * Pure builders for the pod-side setup commands session-create runs over
 * the stream relay after the pod is Ready and streamd answers. Each string
 * is a shell command tail executed as `sh -c <cmd>` in the pod (one shell
 * pass — the same contract `containerExec` had). Kept pure so the exact
 * command text is unit-testable.
 *
 * The tool-agnostic base setup (git identity, tmux server + options,
 * streamd) lives in `workspace-bin/yaac-workspace-init`, the pod's postStart
 * hook; only the steps that need host coordination remain here.
 */
import {
  initWindowCommand,
  resolveInitWindows,
  tmuxCmd,
  type InitWindow,
} from './agent-command'
import { agentWindowName, nameSessionCommand } from './agent-tools'
import { shellEscape } from '#lib/shell'
import { ServerError } from '@yaac/shared/errors'
import { AGENT_TOOLS } from '@yaac/shared/types'
import type { WorkspacePaths } from '#drivers/contract'
import type { AgentTool, YaacConfig } from '@yaac/shared/types'

/**
 * Point the checkout's clone at the main clone's objects, as this launch's
 * workspace sees them, then bring its `origin/*` up to the main clone's —
 * one exec, run in the workspace on every launch, on every driver.
 *
 * The alternates line is the only path-shaped git state a checkout carries
 * (docs/server-git.md). It is always the main clone's objects dir as the
 * SERVER sees it: a pod mounts the main clone read-only at that same path,
 * and a host workspace sees the server's paths as they are, so one string
 * holds everywhere. Rewriting it every launch is what heals a checkout
 * whose data dir moved, or that was last started by a server that sees the
 * data dir elsewhere.
 */
export function buildCloneLinkExec(repoGitDir: string, paths: WorkspacePaths): string {
  return `printf '%s\\n' '${shellEscape(`${repoGitDir}/objects`)}' > ${paths.workspaceDir}/.git/objects/info/alternates`
    + ` && { ${buildOriginRefreshExec(repoGitDir, paths)}; }`
}

/**
 * Fast-forward the checkout's `origin/*` to the main clone's, from the main
 * clone on this disk: every object is already reachable through the
 * alternates line, so nothing crosses the network and no credential is
 * used. Never forced, so a ref the agent fetched ahead of the main clone is
 * not moved back (git rejects that one ref and moves the rest); no
 * `--prune`, so a ref the agent fetched that the main clone has not seen
 * stays; and no FETCH_HEAD, which the agent's own `fetch` + `merge
 * FETCH_HEAD` may be between. Its status is ignored: a ref it could not
 * move is retried by the next refresh.
 */
export function buildOriginRefreshExec(repoGitDir: string, paths: WorkspacePaths): string {
  return `git -C ${paths.workspaceDir} fetch --quiet --no-tags --no-write-fetch-head `
    + `'${shellEscape(repoGitDir)}' 'refs/remotes/origin/*:refs/remotes/origin/*' 2>/dev/null || true`
}

/**
 * Resolve and validate the project's init windows. Rejects every tool
 * name, not just the active tool's: a prewarmed spare can be retooled at
 * claim time, which renames the agent window to the requested tool — an
 * init window with that name would make the tmux target ambiguous.
 * Validation lives here (called before any resource is provisioned) so a
 * bad config fails the create before a workspace or Job exists.
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
 * Create the init-command windows (parallel to the agents) and swap the
 * keepalive placeholder for the real agent — one exec. respawn-window -k
 * kills the `sleep infinity` the postStart hook opened the session with
 * and starts the first agent in the same window, preserving the tmux
 * options configured there.
 *
 * `agentCmds` is one entry per agent session being started, in restore
 * order: a fresh create passes one, and a restart passes whatever was live
 * when the workspace stopped. Only the first can respawn the placeholder;
 * the rest open their own windows.
 *
 * Each entry carries its own tool, because a workspace's conversations need
 * not share one: a codex conversation resumed into a claude workspace must
 * land in a `codex-2` window, not `claude-2` — the window name is what the
 * status watcher reads to pick a tool's status grammar, so a misnamed window
 * gets classified against a title format its agent never emits.
 */
export interface AgentWindowSpec {
  tool: AgentTool
  cmd: string
  /** The conversation it resumes, named on its pane by the same tmux command
   *  that starts it: codex and opencode announce a resumed conversation only
   *  at its next turn, and a pane naming none reads as holding none. */
  resumes?: string
}

export function buildWindowsExec(
  windows: InitWindow[],
  tool: AgentTool,
  agents: AgentWindowSpec[],
  paths: WorkspacePaths,
): string {
  const [primary, ...extra] = agents
  const named = (target: string, spec?: AgentWindowSpec): string =>
    spec?.resumes !== undefined ? ` \\; ${nameSessionCommand(target, spec.tool, spec.resumes)}` : ''
  // Every agent window in ONE tmux invocation: tmux runs a client's command
  // group to completion before reading another client's, so the watcher's
  // listing sees all of them or none, each already naming what it resumes.
  //
  // The placeholder window carries the workspace's tool name, so the primary
  // agent respawns into it whatever tool it runs. A primary whose tool
  // differs is a case restart cannot currently produce (ordinal 0 is the
  // workspace's own agent), and renaming the window would break every
  // `yaac:<tool>` target.
  const agentCmds = [`respawn-window -k -t yaac:${tool} '${primary?.cmd ?? ''}'${named(`yaac:${tool}`, primary)}`]
  extra.forEach((spec, i) => {
    // -d so the extra agents don't steal the active window from the primary,
    // which is what the user attaches to. -c because a new window otherwise
    // starts in the cwd of the client that asked for it — this exec's, `/` in
    // a pod — where the primary inherits the session's: an agent resumed
    // from the wrong directory looks its conversation up under the wrong
    // project.
    const name = agentWindowName(spec.tool, i + 1)
    agentCmds.push(`new-window -d -t yaac -n ${name} -c ${paths.workspaceDir} '${spec.cmd}'${named(`yaac:${name}`, spec)}`)
  })
  return [
    ...windows.map((win) => initWindowCommand(win, paths)),
    `${tmuxCmd(paths)} ${agentCmds.join(' \\; ')}`,
  ].join(' && ')
}
