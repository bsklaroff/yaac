import { spawn, type ChildProcess } from 'node:child_process'
import { access as fsAccess } from 'node:fs/promises'
import { WorkspaceExecError } from '#drivers/contract'

/**
 * This driver's process boundary: everything it does to the host, and the
 * only module its unit tests mock.
 *
 * The k8s driver's bottom is kubectl and the client library; this one's is
 * `child_process`. Keeping it in one module is what lets the launch, exec,
 * teardown and port tests drive the real feature and assert on what it
 * hands the outside world, rather than stubbing a sibling.
 */

export interface RunResult {
  stdout: string
  stderr: string
}

export interface RunOpts {
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Kill the command after this long and reject — a TRANSPORT failure, not
   *  a verdict about the workspace (see `WorkspaceExecError`). */
  timeoutMs?: number
}

/**
 * Run a command on the host and collect its output.
 *
 * The one error distinction the contract forces lands here: a command that
 * RAN and exited nonzero rejects with `WorkspaceExecError`, and everything
 * else — the binary missing, a timeout, a spawn failure — rejects as a
 * plain `Error`. The stale reaper reads a `WorkspaceExecError` from a tmux
 * probe as proof the worktree is dead and tears it down, so widening this
 * would let a host hiccup reap live worktrees.
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
      // Never a WorkspaceExecError: the command did not run, so it says
      // nothing about the workspace.
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

/**
 * Run a command with something on its stdin, and collect its output.
 *
 * The one caller is `ssh-add -`, and the reason it exists is the reason that
 * caller does: a private key handed over a pipe never becomes a file, so
 * there is nothing on disk to forget to delete.
 */
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
    child.stdin?.end(input)
  })
}

/**
 * Start an ssh-agent bound to `sock`, detached, and answer with its pid.
 *
 * `-D` keeps it in the foreground of its own process so the pid we get is
 * the agent itself rather than a parent that forked and exited — which is
 * what makes the pid recorded in the workspace marker the one teardown can
 * signal. Detached and `unref`ed for the same reason the tmux server is: it
 * belongs to the worktree, not to the server that created it, and must
 * survive a server restart.
 *
 * Resolves once the socket exists, so the `ssh-add` that follows cannot race
 * the bind.
 */
export async function spawnSshAgent(sock: string): Promise<number> {
  const child = spawn('ssh-agent', ['-D', '-a', sock], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  // Attached BEFORE anything can throw, as `runHost` does. A spawn failure
  // (no `ssh-agent` on this host) surfaces as an 'error' event on the next
  // tick, and an unhandled one on a ChildProcess is an uncaught exception —
  // which this process has no handler for, so a single SSH project on a host
  // without ssh-agent would take the whole server down rather than failing
  // its create.
  let spawnError: Error | undefined
  child.on('error', (err) => { spawnError = err })

  const pid = child.pid
  if (pid === undefined) {
    // The event has not necessarily fired yet; one tick is enough for it,
    // and its message names the actual cause.
    await new Promise((r) => setTimeout(r, 0))
    throw spawnError ?? new Error('ssh-agent did not start')
  }

  const deadline = Date.now() + 5_000
  for (;;) {
    if (spawnError) throw spawnError
    try {
      await fsAccess(sock)
      return pid
    } catch {
      if (Date.now() >= deadline) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch { /* already gone */ }
        throw new Error(`ssh-agent did not bind ${sock} within 5s`)
      }
      await new Promise((r) => setTimeout(r, 50))
    }
  }
}

/**
 * Whether a binary resolves on PATH. Used by the host check, the create's
 * launch preflight and the launch's shell selection; never throws.
 *
 * The name is a positional argument rather than interpolated into the
 * script, so it is data to the shell no matter who supplies it. Every
 * caller today passes a validated tool name or a table constant; this is
 * what keeps that from being load-bearing.
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
 * Every descendant of `roots`, roots included — the workspace's process
 * tree, which is what "this worktree's ports" and "kill what is left" both
 * mean here.
 *
 * Read from `ps` rather than `/proc` so one implementation serves Linux and
 * macOS; the tree is walked breadth-first from a single snapshot, so a
 * process that forks mid-walk is simply missed until the next sweep.
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

/**
 * TCP ports the given processes are LISTENing on.
 *
 * `lsof` on both platforms: it is the one tool that answers "which of THESE
 * processes is listening" in a single call, which is the question — a
 * worktree's ports are its own process tree's, not the host's. A host
 * without lsof reports nothing rather than failing, and the host check says
 * so up front.
 */
export async function listeningPorts(pids: number[]): Promise<number[]> {
  if (pids.length === 0) return []
  let out: string
  try {
    ({ stdout: out } = await runHost([
      'lsof', '-a', '-p', pids.join(','), '-iTCP', '-sTCP:LISTEN', '-P', '-n', '-Fn',
    ], { timeoutMs: 10_000 }))
  } catch {
    // Also the ordinary "nothing is listening" case: lsof exits 1 when no
    // file matches, which is indistinguishable from a real failure here and
    // means the same thing either way.
    return []
  }
  const ports = new Set<number>()
  for (const line of out.split('\n')) {
    // -Fn emits one field per line; the name field starts with `n`, e.g.
    // `n*:3000` or `n127.0.0.1:3000`.
    if (!line.startsWith('n')) continue
    const m = /:(\d+)$/.exec(line.slice(1))
    if (m) ports.add(Number(m[1]))
  }
  return [...ports].sort((a, b) => a - b)
}

/** Signal a set of pids, ignoring the ones that already went away. */
export function killPids(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal)
    } catch {
      // Already gone, or not ours — either way there is nothing to do.
    }
  }
}

/**
 * Whether `pid` is this workspace's ssh-agent, rather than whatever process
 * has since inherited that number.
 *
 * A recorded pid is advisory — the same reason the tmux one is — but "do not
 * signal it" is the wrong conclusion for this one: the process holds a
 * private key in memory, and leaving it alive until the host reboots is the
 * failure the per-worktree agent exists to prevent. So the identity is
 * checked instead of assumed, against the socket path no other agent binds.
 *
 * Never throws: a `ps` that fails answers "not ours", which loses only a
 * best-effort kill.
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
