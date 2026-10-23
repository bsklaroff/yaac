import { spawn, type ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { access as fsAccess, readFile, stat, statfs } from 'node:fs/promises'
import os from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { WorkspaceExecError } from '#drivers/contract'
import { waitFor } from '@yaac/shared/wait-for'

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
   *  `WorkspaceExecError`). With `signal`, everything the command started
   *  is killed too. */
  timeoutMs?: number
  /** Kill the command and everything it started, and reject with an
   *  `AbortError`. The command then runs in its own process group. */
  signal?: AbortSignal
  /** Written to the command's stdin, which is otherwise `/dev/null`. */
  input?: string
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
        stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        ...(opts.signal ? { detached: true } : {}),
      })
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    /** The command, and with `signal` everything it started. */
    const kill = (sig: NodeJS.Signals): void => {
      try {
        if (opts.signal && child.pid !== undefined) process.kill(-child.pid, sig)
        else child.kill(sig)
      } catch { /* already gone */ }
    }
    const timer = opts.timeoutMs === undefined ? null : setTimeout(() => {
      if (settled) return
      settled = true
      done()
      kill('SIGKILL')
      reject(new Error(`host command timed out after ${String(opts.timeoutMs)}ms: ${cmd}`))
    }, opts.timeoutMs)
    const onAbort = (): void => {
      if (settled) return
      settled = true
      done()
      kill('SIGTERM')
      reject(new DOMException(`host command abandoned: ${cmd}`, 'AbortError'))
    }
    const done = (): void => {
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    }
    if (opts.signal?.aborted) onAbort()
    else opts.signal?.addEventListener('abort', onAbort, { once: true })

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
    if (opts.input === undefined) return
    // A child that exits before reading raises EPIPE on stdin, which would
    // crash the server with no listener; `close` reports the failure.
    child.stdin?.on('error', () => { /* reported via close */ })
    child.stdin?.end(opts.input)
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
 * Where a binary resolves on PATH: the first executable file of that name in
 * its absolute directories, which is what `command -v` finds for anything
 * but a shell builtin. Always an absolute path. Looked up in-process, since a shell per check costs a
 * process start on every create. Null if none; never throws.
 */
export async function findOnPath(binary: string): Promise<string | null> {
  if (binary === '' || binary.includes('/')) return null
  // eslint-disable-next-line no-process-env -- the PATH every process this driver starts inherits
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    // A relative entry would resolve against the server's cwd, not where
    // the caller runs it.
    if (!isAbsolute(dir)) continue
    const file = join(dir, binary)
    const executable = await stat(file).then(
      async (st) => st.isFile() && await fsAccess(file, constants.X_OK).then(() => true, () => false),
      () => false,
    )
    if (executable) return file
  }
  return null
}

/** Whether a binary resolves on PATH (`findOnPath`). */
export async function onPath(binary: string): Promise<boolean> {
  return await findOnPath(binary) !== null
}

/** One process in a `ProcessTable`. */
export interface ProcessRow {
  ppid: number
  rssBytes: number
  /** CPU time used so far. Whole seconds on Linux, whose `ps` rounds. */
  cpuSeconds: number
}

/** Every process on the host at one instant, by pid. */
export interface ProcessTable {
  at: number
  rows: Map<number, ProcessRow>
}

/** `ps`'s `time` column, `[dd-][hh:]mm:ss[.cc]`, in seconds. */
function parseCpuTime(text: string): number {
  const [days, clock] = text.includes('-') ? text.split('-') : ['0', text]
  return Number(days) * 86_400
    + clock.split(':').reduce((sum, part) => sum * 60 + Number(part), 0)
}

/**
 * One `ps` snapshot of every process (portable to Linux and macOS), or null
 * if `ps` failed. The port sweep takes one per tick and the usage report
 * reads the same ones, so neither spawns its own.
 */
export async function processTable(): Promise<ProcessTable | null> {
  let out: string
  try {
    ({ stdout: out } = await runHost(['ps', '-axo', 'pid=,ppid=,rss=,time='], { timeoutMs: 10_000 }))
  } catch {
    return null
  }
  const rows = new Map<number, ProcessRow>()
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line)
    if (!m) continue
    rows.set(Number(m[1]), {
      ppid: Number(m[2]),
      rssBytes: Number(m[3]) * 1024,
      cpuSeconds: parseCpuTime(m[4]) || 0,
    })
  }
  return { at: Date.now(), rows }
}

/**
 * Every descendant of `roots` in `table`, roots included: the workspace's
 * process tree. Just the roots without a table. A process forked after the
 * snapshot is missed until the next.
 */
export function descendantPids(table: ProcessTable | null, roots: number[]): number[] {
  if (!table) return roots
  const children = new Map<number, number[]>()
  for (const [pid, { ppid }] of table.rows) {
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

/** The host's memory and swap. */
export interface HostMemory {
  totalBytes: number
  usedBytes: number
  swapTotalBytes: number
  swapUsedBytes: number
}

/**
 * Read from `/proc/meminfo` on Linux and `vm_stat` / `sysctl vm.swapusage`
 * on macOS, because `os.freemem()` on macOS leaves out reclaimable cache
 * and so reads as nearly full.
 */
export async function hostMemory(): Promise<HostMemory> {
  const totalBytes = os.totalmem()
  if (process.platform === 'linux') {
    const info = new Map<string, number>()
    for (const line of (await readFile('/proc/meminfo', 'utf8')).split('\n')) {
      const m = /^(\w+):\s+(\d+)/.exec(line)
      if (m) info.set(m[1], Number(m[2]) * 1024)
    }
    const swapTotalBytes = info.get('SwapTotal') ?? 0
    return {
      totalBytes,
      usedBytes: totalBytes - (info.get('MemAvailable') ?? os.freemem()),
      swapTotalBytes,
      swapUsedBytes: swapTotalBytes - (info.get('SwapFree') ?? swapTotalBytes),
    }
  }
  if (process.platform === 'darwin') {
    const [vm, swap] = await Promise.all([
      runHost(['vm_stat'], { timeoutMs: 5_000 }),
      runHost(['sysctl', '-n', 'vm.swapusage'], { timeoutMs: 5_000 }),
    ])
    const pageSize = Number(/page size of (\d+) bytes/.exec(vm.stdout)?.[1] ?? 4096)
    const pages = (label: string): number =>
      Number(new RegExp(`${label}:\\s+(\\d+)`).exec(vm.stdout)?.[1] ?? 0) * pageSize
    // What Activity Monitor calls "Memory Used": app, wired and compressed.
    const usedBytes = pages('Pages active') + pages('Pages wired down')
      + pages('Pages occupied by compressor')
    const mib = (label: string): number =>
      Number(new RegExp(`${label} = ([\\d.]+)M`).exec(swap.stdout)?.[1] ?? 0) * 1024 * 1024
    return { totalBytes, usedBytes, swapTotalBytes: mib('total'), swapUsedBytes: mib('used') }
  }
  return { totalBytes, usedBytes: totalBytes - os.freemem(), swapTotalBytes: 0, swapUsedBytes: 0 }
}

/** CPU time the host has spent, summed over its cores, in ms. */
export function hostCpuTimes(): { idleMs: number; totalMs: number; cores: number } {
  const cpus = os.cpus()
  let idleMs = 0
  let totalMs = 0
  for (const { times } of cpus) {
    idleMs += times.idle
    totalMs += times.user + times.nice + times.sys + times.idle + times.irq
  }
  return { idleMs, totalMs, cores: cpus.length }
}

/** Used and total bytes of the filesystem holding `dir`. */
export async function diskUsage(dir: string): Promise<{ usedBytes: number; capacityBytes: number }> {
  const st = await statfs(dir)
  return { usedBytes: (st.blocks - st.bfree) * st.bsize, capacityBytes: st.blocks * st.bsize }
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
