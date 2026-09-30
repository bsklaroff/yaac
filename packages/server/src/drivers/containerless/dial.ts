import { spawn } from 'node:child_process'
import pty from '@lydell/node-pty'
import { workspaceRunEnvironment } from './launch'
import { containerlessWorkspacePaths } from './paths'
import type { StreamChild, StreamPty } from '#drivers/contract'

/**
 * The two long-lived streams into a workspace. Here they are plain local
 * processes run in the workspace's checkout with its environment; no relay
 * or tunnel is involved.
 */

/** See `WorkspaceDriver.dialCtrl`. `spawn` already reports a failed start
 *  as an `error` event, as the contract requires. */
export function dialCtrlStream(jobName: string, argv: string[]): StreamChild {
  const paths = containerlessWorkspacePaths(jobName)
  const [cmd, ...args] = argv
  return spawn(cmd, args, {
    cwd: paths.workspaceDir,
    env: workspaceRunEnvironment(jobName),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

/** See `WorkspaceDriver.dialPty`. A local PTY. */
export function dialPtyStream(
  jobName: string,
  argv: string[],
  size: { cols?: number; rows?: number },
): StreamPty {
  const paths = containerlessWorkspacePaths(jobName)
  const [cmd, ...args] = argv
  const proc = pty.spawn(cmd, args, {
    name: 'xterm-256color',
    cols: size.cols ?? 80,
    rows: size.rows ?? 24,
    cwd: paths.workspaceDir,
    env: workspaceRunEnvironment(jobName) as Record<string, string>,
  })
  return {
    onData: (cb) => { proc.onData(cb) },
    onExit: (cb) => { proc.onExit(({ exitCode }) => cb({ exitCode })) },
    write: (data) => { proc.write(data) },
    resize: (cols, rows) => {
      // A resize racing the exit throws; the stream is over either way.
      try { proc.resize(cols, rows) } catch { /* gone */ }
    },
    kill: (signal) => {
      try { proc.kill(signal) } catch { /* gone */ }
    },
  }
}

/**
 * See `WorkspaceDriver.reviveStatusStream`. Nothing to repair: the streams
 * come straight from tmux, and if tmux is gone so is the workspace.
 */
export function reviveStatusStream(): Promise<void> {
  return Promise.resolve()
}
