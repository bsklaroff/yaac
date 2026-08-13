import { spawn } from 'node:child_process'
import pty from '@lydell/node-pty'
import { containerlessWorkspacePaths, refFromJobName } from './paths'
import { workspaceEnv } from './registry'
import type { StreamChild, StreamPty } from '#drivers/contract'

/**
 * The two long-lived streams into a workspace.
 *
 * Both are the degenerate case of what the contract asks for, which is why
 * the contract asks for it in those shapes: `StreamChild` is "deliberately
 * the shape `child_process` already has — a driver that really does spawn a
 * local child satisfies it as-is", and this is that driver. There is no
 * relay, no token and no tunnel; the argv the caller wrote for a workspace
 * runs on the host, in the workspace's checkout, with its environment.
 */

function envFor(jobName: string): NodeJS.ProcessEnv {
  const { worktreeId } = refFromJobName(jobName)
  // The server's own environment is the fallback, and after a restart it is
  // the ordinary case: the table's copy is lost while the tmux server holds
  // the real one, and everything dialed from then on is a tmux client that
  // only needs to reach the socket.
  // eslint-disable-next-line no-process-env -- inheriting the host environment IS this driver's model; there is no image to have provided one
  return workspaceEnv(worktreeId) ?? process.env
}

/**
 * See `WorktreeDriver.dialCtrl`. Synchronous by contract, which a real
 * `spawn` satisfies for free: the object exists immediately and a failure to
 * start arrives as an `error` event, which is exactly the "report a failed
 * dial as an observation rather than a throw" the callers' backoff wants.
 */
export function dialCtrlStream(jobName: string, argv: string[]): StreamChild {
  const paths = containerlessWorkspacePaths(jobName)
  const [cmd, ...args] = argv
  return spawn(cmd, args, {
    cwd: paths.workspaceDir,
    env: envFor(jobName),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

/** See `WorktreeDriver.dialPty`. A real PTY on the host — the same library
 *  the pod driver's in-pod stream daemon uses at the other end of its
 *  relay, with the relay taken out. */
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
    env: envFor(jobName) as Record<string, string>,
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
 * See `WorktreeDriver.reviveStatusStream`.
 *
 * Nothing to repair: the pod driver re-execs its in-pod stream daemon
 * because the daemon is a separate process that can die while the pod
 * lives, but here the "stream daemon" is the tmux server itself — if that is
 * gone the workspace is gone, which is the liveness edge's business and not
 * a repair. Resolving rather than rejecting is what the contract asks of a
 * driver with nothing to do here.
 */
export function reviveStatusStream(): Promise<void> {
  return Promise.resolve()
}
