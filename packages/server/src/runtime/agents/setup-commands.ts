/**
 * Pure builders for the in-workspace setup commands run after the
 * workspace is ready. Each is a command tail run as `sh -c <cmd>` (one
 * shell pass). Pure so the exact text is unit-testable.
 *
 * Tool-agnostic base setup (git identity, tmux, streamd) is done by
 * `workspace-bin/yaac-workspace-init`; only steps needing host coordination
 * are here.
 */
import { initWindowCommand, tmuxCmd, type InitWindow } from './agent-command'
import { agentWindowName, nameSessionCommand } from './agent-tools'
import type { WorkspacePaths } from '#drivers/contract'
import type { AgentTool } from '@yaac/shared/types'

/**
 * Create the init-command windows and replace the keepalive placeholder
 * with the first agent, in one exec. `respawn-window -k` kills the
 * placeholder keepalive and keeps the window's tmux options.
 *
 * `agentCmds` has one entry per conversation to start, in restore order: one
 * for a fresh create, whatever was live for a restart. Only the first
 * respawns the placeholder; the rest get their own windows.
 *
 * Each entry has its own tool, since a codex conversation resumed into a
 * claude workspace must land in `codex-2`: the window name selects the
 * status parser.
 */
export interface AgentWindowSpec {
  tool: AgentTool
  cmd: string
  /** The conversation it resumes, named on its pane by the command that
   *  starts it: codex and opencode announce a resumed conversation only at
   *  its next turn. */
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
  // One tmux invocation for all agent windows: tmux runs a client's command
  // group to completion, so the watcher sees all of them or none.
  //
  // The placeholder window has the workspace's tool name, so the primary
  // respawns into it regardless of tool (restart never makes the primary a
  // different tool, and renaming would break `yaac:<tool>` targets).
  const agentCmds = [`respawn-window -k -t yaac:${tool} '${primary?.cmd ?? ''}'${named(`yaac:${tool}`, primary)}`]
  extra.forEach((spec, i) => {
    // -d keeps the primary as the active window. -c because a new window
    // otherwise starts in this exec's cwd (`/` in a pod), and an agent
    // resumed from the wrong directory looks up the wrong project.
    const name = agentWindowName(spec.tool, i + 1)
    agentCmds.push(`new-window -d -t yaac -n ${name} -c ${paths.workspaceDir} '${spec.cmd}'${named(`yaac:${name}`, spec)}`)
  })
  return [
    ...windows.map((win) => initWindowCommand(win, paths)),
    `${tmuxCmd(paths)} ${agentCmds.join(' \\; ')}`,
  ].join(' && ')
}
