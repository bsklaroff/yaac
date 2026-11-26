import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import pty from '@lydell/node-pty'
import { workspaceRunEnvironment } from './launch'
import { containerlessWorkspacePaths } from './paths'
import type { StreamChild, StreamPty } from '#drivers/contract'

/**
 * The long-lived streams into a workspace. Here they are plain local
 * processes run in the workspace's checkout with its environment, or a
 * local socket; no relay or tunnel is involved.
 */

/**
 * See `WorkspaceDriver.dialCtrl`. `spawn` already reports a failed start
 * as an `error` event, as the contract requires. A write that lands after
 * the child died but before its `exit` is handled raises EPIPE on stdin,
 * which would crash the server with no listener there; `exit` reports the
 * closed stream.
 */
export function dialCtrlStream(jobName: string, argv: string[]): StreamChild {
  const paths = containerlessWorkspacePaths(jobName)
  const [cmd, ...args] = argv
  const child = spawn(cmd, args, {
    cwd: paths.workspaceDir,
    env: workspaceRunEnvironment(jobName),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin.on('error', () => { /* reported via exit */ })
  return child
}

/** How a socket dial waits for the socket to be bound: acpd binds it a
 *  moment after tmux opens its window. */
const SOCKET_CONNECT_TRIES = 40
const SOCKET_CONNECT_INTERVAL_MS = 50

/**
 * See `WorkspaceDriver.dialSocket`. The socket is this host's, so the
 * server connects to it itself, retrying while it is not bound yet. Writes
 * before the connect are held.
 */
export function dialSocketStream(_jobName: string, socketPath: string): StreamChild {
  const emitter = new EventEmitter()
  const dataCbs: Array<(chunk: Buffer) => void> = []
  const held: string[] = []
  let sock: net.Socket | null = null
  let killed = false
  const attempt = (tries: number): void => {
    if (killed) return
    const s = net.connect({ path: socketPath })
    s.once('error', () => {
      if (sock === s) return
      if (tries <= 1 || killed) emitter.emit('exit')
      else setTimeout(() => { attempt(tries - 1) }, SOCKET_CONNECT_INTERVAL_MS)
    })
    s.once('connect', () => {
      if (killed) {
        s.destroy()
        return
      }
      sock = s
      s.on('data', (chunk: Buffer) => { for (const cb of dataCbs) cb(chunk) })
      s.on('error', () => { /* 'close' follows and emits exit */ })
      s.on('close', () => emitter.emit('exit'))
      for (const d of held) s.write(d)
      held.length = 0
    })
  }
  attempt(SOCKET_CONNECT_TRIES)
  return {
    stdin: {
      write: (data) => {
        if (sock) sock.write(data)
        else held.push(data)
      },
    },
    stdout: { on: (_event, cb) => { dataCbs.push(cb) } },
    stderr: { on: () => { /* a socket has no stderr */ } },
    on: (event, cb) => { emitter.on(event, cb) },
    kill: () => {
      killed = true
      sock?.destroy()
      return true
    },
  }
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
    env: workspaceRunEnvironment(jobName),
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
