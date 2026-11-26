/**
 * Pure builders for the in-workspace setup commands run after the
 * workspace is ready. Each is a command tail run as `sh -c <cmd>` (one
 * shell pass). Pure so the exact text is unit-testable.
 *
 * Tool-agnostic base setup (git identity, tmux, streamd) is done by
 * `workspace-bin/yaac-workspace-init`; only steps needing host coordination
 * are here.
 */
import { agentOptionCommands, NEW_WINDOW_TARGET, tmuxCmd, windowTarget } from './agent-command'
import { nameSessionCommand } from './agent-tools'
import { KEEPER_STARTING, KEEPER_WINDOW, type WorkspacePaths } from '#drivers/contract'
import type { AgentMode, AgentOptions, AgentTool } from '@yaac/shared/types'

/**
 * One session's window to open: its name, which is its handle, and the
 * command that runs its agent.
 */
export interface SessionWindowSpec {
  tool: AgentTool
  mode: AgentMode
  window: string
  cmd: string
  /** The directory its agent runs in, as the workspace sees it: the
   *  workspace dir or a checkout's (`sessions.cwd`). */
  cwd: string
  /** The conversation it resumes, named on its pane by the command that
   *  starts it: codex and opencode announce a resumed conversation only at
   *  its next turn. */
  resumes?: string
  /** Its agent options, set on its window as it opens
   *  (`agentOptionCommands`). */
  agentOptions?: AgentOptions
}

/** The commands that follow a window's own in its tmux invocation: its
 *  agent options, and the conversation it resumes. */
function windowSettings(spec: SessionWindowSpec): string {
  return [
    ...agentOptionCommands(spec.window, spec.agentOptions ?? {}),
    ...(spec.resumes !== undefined ? [nameSessionCommand(windowTarget(spec.window), spec.tool, spec.resumes)] : []),
  ].map((cmd) => ` \\; ${cmd}`).join('')
}

/**
 * The tmux command that appends a window's output to `<window>.log` in the
 * life's log dir (docs/workspace-steps.md "Logs"): the window `target`, or
 * without one the window a hook runs for. A pipe outlives a respawn of its
 * window.
 */
export function pipeToLogCommand(target?: string): string {
  return `pipe-pane ${target !== undefined ? `-t ${target} ` : ''}-o "exec yaac-log-writer '#{@yaac-log-dir}/#{window_name}.log'"`
}

/** The tmux command that marks the workspace's setup finished. */
export function finishSetupCommand(paths: WorkspacePaths): string {
  return `${tmuxCmd(paths)} rename-window -t ${windowTarget(KEEPER_STARTING)} ${KEEPER_WINDOW} 2>/dev/null || true`
}

/** Replace a session's window's process with `spec`'s, keeping the window
 *  and its options: how an exited session is resumed. */
export function buildRespawnExec(spec: SessionWindowSpec, paths: WorkspacePaths): string {
  const target = windowTarget(spec.window)
  return `${tmuxCmd(paths)} respawn-window -k -t ${target} -c ${spec.cwd} '${spec.cmd}'${windowSettings(spec)}`
}

/**
 * Create the sessions' windows, in one exec; the empty string for nothing
 * to run. `first` are tmux commands the same invocation runs ahead of them
 * (a life's log hooks, which a window must open under). The commands alone
 * are `buildWindowsCommands`.
 *
 * Each session's window keeps its pane when the agent exits
 * (`remain-on-exit`), so an agent that quits or crashes leaves its session
 * to be resumed or closed rather than vanishing. An `acp` session's window
 * holds acpd's own lines and the adapter's stderr, so it is logged for the
 * chat pane to offer once the agent exits; a `tui` one's full-screen
 * redraws are not. `-d` keeps whichever window is current, and `-c`
 * matters because a new window otherwise starts in this exec's cwd (`/` in
 * a pod), and an agent resumed from the wrong directory looks up the wrong
 * project.
 */
export function buildWindowsExec(
  sessions: SessionWindowSpec[],
  paths: WorkspacePaths,
  first: string[] = [],
): string {
  const cmds = buildWindowsCommands(sessions, first)
  return cmds === '' ? '' : `${tmuxCmd(paths)} ${cmds}`
}

/**
 * `buildWindowsExec`'s tmux commands without the `tmux` that runs them,
 * joined as a shell passes them to one tmux (`\;` between commands): what
 * `WorkspaceDriver.awaitReady` takes as `open`.
 */
export function buildWindowsCommands(sessions: SessionWindowSpec[], first: string[] = []): string {
  // One tmux invocation for all of it: tmux runs a client's command group
  // to completion, so the watcher sees all the windows or none, and each
  // further start of tmux costs tens of milliseconds in a gVisor pod.
  const sessionCmds = sessions.map((spec) => {
    const target = windowTarget(spec.window)
    return `new-window -d -t ${NEW_WINDOW_TARGET} -n ${spec.window} -c ${spec.cwd} '${spec.cmd}'`
      + ` \\; set-option -t ${target} remain-on-exit on`
      + (spec.mode === 'acp' ? ` \\; ${pipeToLogCommand(target)}` : '')
      + windowSettings(spec)
  })
  const cmds = [...first, ...sessionCmds]
  return cmds.join(' \\; ')
}
