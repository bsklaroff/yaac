import { spawn, type ChildProcess } from 'node:child_process'
import { access as fsAccess } from 'node:fs/promises'
import { WorkspaceExecError } from '#drivers/contract'
import { waitFor } from '#lib/wait-for'

/**
 * This driver's process boundary: every host process it runs goes through
 * here, so this is the only module its unit tests mock.
 */

export interface RunResult {
  stdout: string
  stderr: string
}

export interface RunOpts {
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Kill and reject after this long, as a transport failure (not a
   *  `WorkspaceExecError`). */
  timeoutMs?: number
}

/**
 * Run a command on the host and collect its output. Only a command that ran
 * and exited nonzero rejects with `WorkspaceExecError`; a missing binary,
 * timeout or spawn failure is a plain `Error`. The stale reaper relies on
 * this to avoid reaping live workspaces.
 */
export function runHost(argv: string[], opts: RunOpts = {}): Promise<RunResult> {
  const [cmd, ...args] = argv
  if (cmd === undefined) return Promise.reject(new Error('runHost: empty argv'))
  return new Promise<RunResult>((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(cmd, args, {
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts.env !== undefined ? { env: opts.env } : {}),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = opts.timeoutMs === undefined ? null : setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`host command timed out after ${String(opts.timeoutMs)}ms: ${cmd}`))
    }, opts.timeoutMs)
    const done = (): void => { if (timer) clearTimeout(timer) }

    child.stdout?.on('data', (c: Buffer) => { stdout += c.toString() })
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString() })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      done()
      // The command did not run, so not a WorkspaceExecError.
      reject(err)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      done()
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      reject(new WorkspaceExecError(
        `command exited ${String(code)}`, code ?? -1, stdout, stderr,
      ))
    })
  })
}

/** `runHost` with `input` on stdin (used to pipe a private key to
 *  `ssh-add -` so it never touches disk). */
export function runHostWithInput(
  argv: string[],
  input: string,
  opts: RunOpts = {},
): Promise<RunResult> {
  const [cmd, ...args] = argv
  if (cmd === undefined) return Promise.reject(new Error('runHostWithInput: empty argv'))
  return new Promise<RunResult>((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(cmd, args, {
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts.env !== undefined ? { env: opts.env } : {}),
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }
    let stdout = ''
    let stderr = ''
    let timer: NodeJS.Timeout | undefined
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`${cmd} timed out after ${String(opts.timeoutMs)}ms`))
      }, opts.timeoutMs)
    }
    child.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf8') })
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf8') })
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      reject(new WorkspaceExecError(
        `${cmd} exited ${String(code)}: ${stderr.trim()}`,
        code ?? 1,
        stdout,
        stderr,
      ))
    })
    // A child that exits before reading raises EPIPE on stdin, which would
    // crash the server with no listener; `close` reports the failure.
    child.stdin?.on('error', () => { /* reported via close */ })
    child.stdin?.end(input)
  })
}

/**
 * Start a detached ssh-agent bound to `sock` (it must survive a server
 * restart, like tmux) and return its pid once the socket exists. `-D` keeps
 * the agent itself as the child, so the pid is the one teardown signals.
 */
export async function spawnSshAgent(sock: string): Promise<number> {
  const child = spawn('ssh-agent', ['-D', '-a', sock], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  // Attach before anything can throw: an unhandled spawn 'error' event
  // (no ssh-agent installed) would crash the server.
  let spawnError: Error | undefined
  child.on('error', (err) => { spawnError = err })

  const pid = child.pid
  if (pid === undefined) {
    // Wait one tick for the 'error' event, which names the cause.
    await new Promise((r) => setTimeout(r, 0))
    throw spawnError ?? new Error('ssh-agent did not start')
  }

  const bound = await waitFor(async () => {
    if (spawnError) throw spawnError
    return fsAccess(sock).then(() => true, () => false)
  }, { timeoutMs: 5_000, intervalMs: 50 })
  if (bound) return pid
  try {
    process.kill(pid, 'SIGKILL')
  } catch { /* already gone */ }
  throw new Error(`ssh-agent did not bind ${sock} within 5s`)
}

/**
 * Whether a binary resolves on PATH. Never throws. The name is passed as an
 * argument, not interpolated into the script.
 */
export async function onPath(binary: string): Promise<boolean> {
  try {
    await runHost(
      ['sh', '-c', 'command -v -- "$1"', 'onPath', binary],
      { timeoutMs: 5_000 },
    )
    return true
  } catch {
    return false
  }
}

/**
 * Every descendant of `roots`, roots included: the workspace's process tree.
 * Uses one `ps` snapshot (portable to Linux and macOS); a process forked
 * mid-walk is missed until the next sweep.
 */
export async function descendantPids(roots: number[]): Promise<number[]> {
  if (roots.length === 0) return []
  let out: string
  try {
    ({ stdout: out } = await runHost(['ps', '-axo', 'pid=,ppid='], { timeoutMs: 10_000 }))
  } catch {
    return roots
  }
  const children = new Map<number, number[]>()
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    const ppid = Number(m[2])
    children.set(ppid, [...(children.get(ppid) ?? []), pid])
  }
  const seen = new Set<number>(roots)
  const queue = [...roots]
  while (queue.length > 0) {
    const pid = queue.shift() as number
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      queue.push(child)
    }
  }
  return [...seen]
}

/** One TCP listener: its port, and the address to dial it on (the bound
 *  address, or its family's loopback for a wildcard). */
export interface Listener {
  port: number
  host: string
}

/**
 * TCP ports the given processes listen on, via `lsof` (Linux and macOS).
 * Empty if lsof is missing; the host check warns about that.
 */
export async function listeningPorts(pids: number[]): Promise<Listener[]> {
  if (pids.length === 0) return []
  let out: string
  try {
    // `-b` avoids stat-ing mounts, so a hung network mount cannot hang the
    // sweep; `-w` silences the resulting warnings. ports.test.ts asserts the
    // flags.
    ({ stdout: out } = await runHost([
      'lsof', '-b', '-w', '-a', '-p', pids.join(','), '-iTCP', '-sTCP:LISTEN', '-P', '-n', '-Ftn',
    ], { timeoutMs: 10_000 }))
  } catch {
    // lsof also exits 1 when nothing is listening.
    return []
  }
  // -F output: `t` (IPv4/IPv6) then `n` (e.g. `n*:3000`, `n[::1]:3000`) per
  // file. `t` tells which loopback a `*` wildcard is reachable on.
  const byPort = new Map<number, Listener>()
  let family = ''
  for (const line of out.split('\n')) {
    if (line.startsWith('t')) {
      family = line.slice(1)
      continue
    }
    if (!line.startsWith('n')) continue
    const m = /^(.*):(\d+)$/.exec(line.slice(1))
    if (!m) continue
    const port = Number(m[2])
    const bound = m[1].replace(/^\[|\]$/g, '')
    const host = bound === '*' ? (family === 'IPv6' ? '::1' : '127.0.0.1') : bound
    // A dev server listening on both loopbacks is one port; either answers.
    if (!byPort.has(port)) byPort.set(port, { port, host })
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port)
}

/** The pids of a set still running (or not ours to signal). */
export function livePids(pids: number[]): number[] {
  return pids.filter((pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM'
    }
  })
}

/** Signal a set of pids, ignoring the ones that already went away. */
export function killPids(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal)
    } catch {
      // Already gone, or not ours.
    }
  }
}

/**
 * Whether `pid` is still this workspace's ssh-agent (checked by its socket
 * path), not a process that reused the number. It holds a private key, so
 * teardown should kill it when it can. Never throws.
 */
export async function isSshAgentFor(pid: number, sock: string): Promise<boolean> {
  try {
    const { stdout } = await runHost(
      ['ps', '-o', 'args=', '-p', String(pid)],
      { timeoutMs: 5_000 },
    )
    return stdout.includes('ssh-agent') && stdout.includes(sock)
  } catch {
    return false
  }
}
