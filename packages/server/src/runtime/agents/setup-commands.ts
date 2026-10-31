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
import { nameSessionCommand } from './agent-tools'
import { KEEPER_STARTING, KEEPER_WINDOW, type WorkspacePaths } from '#drivers/contract'
import type { AgentTool } from '@yaac/shared/types'

/**
 * One session's window to open: its name, which is its handle, and the
 * command that runs its agent.
 */
export interface SessionWindowSpec {
  tool: AgentTool
  window: string
  cmd: string
  /** The conversation it resumes, named on its pane by the command that
   *  starts it: codex and opencode announce a resumed conversation only at
   *  its next turn. */
  resumes?: string
}

/** The tmux command that marks the workspace's setup finished. */
export function finishSetupCommand(paths: WorkspacePaths): string {
  return `${tmuxCmd(paths)} rename-window -t yaac:${KEEPER_STARTING} ${KEEPER_WINDOW} 2>/dev/null || true`
}

/**
 * Create the init-command windows and the sessions' windows, in one exec.
 *
 * Each session's window keeps its pane when the agent exits
 * (`remain-on-exit`), so an agent that quits or crashes leaves its session
 * to be resumed or closed rather than vanishing. `-d` keeps whichever window
 * is current, and `-c` matters because a new window otherwise starts in this
 * exec's cwd (`/` in a pod), and an agent resumed from the wrong directory
 * looks up the wrong project.
 *
 * Init windows and sessions may be built apart: with no sessions this opens
 * only the init windows, and with neither it is the empty string.
 */
/** Replace a session's window's process with `spec`'s, keeping the window
 *  and its options: how an exited session is resumed. */
export function buildRespawnExec(spec: SessionWindowSpec, paths: WorkspacePaths): string {
  const target = `yaac:${spec.window}`
  return `${tmuxCmd(paths)} respawn-window -k -t ${target} -c ${paths.workspaceDir} '${spec.cmd}'`
    + (spec.resumes !== undefined ? ` \\; ${nameSessionCommand(target, spec.tool, spec.resumes)}` : '')
}

export function buildWindowsExec(
  windows: InitWindow[],
  sessions: SessionWindowSpec[],
  paths: WorkspacePaths,
): string {
  const windowCmds = windows.map((win) => initWindowCommand(win, paths))
  if (sessions.length === 0) return windowCmds.join(' && ')
  // One tmux invocation for all session windows: tmux runs a client's
  // command group to completion, so the watcher sees all of them or none.
  const sessionCmds = sessions.map((spec) => {
    const target = `yaac:${spec.window}`
    return `new-window -d -t yaac -n ${spec.window} -c ${paths.workspaceDir} '${spec.cmd}'`
      + ` \\; set-option -t ${target} remain-on-exit on`
      + (spec.resumes !== undefined ? ` \\; ${nameSessionCommand(target, spec.tool, spec.resumes)}` : '')
  })
  return [...windowCmds, `${tmuxCmd(paths)} ${sessionCmds.join(' \\; ')}`].join(' && ')
}
