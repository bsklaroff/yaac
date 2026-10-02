/**
 * Runner for long, chatty subprocesses (`podman build`/`push`, `kubectl
 * exec` into a builder pod): streams output to the log and stops a child
 * that will not cooperate. Two budgets:
 *
 * - **idle** (`idleTimeoutMs`, optional): reset by any output or accepted
 *   input. The main bound for builds, since a cold build can legitimately
 *   run far longer than a warm one but podman prints steadily.
 * - **total** (`timeoutMs`): catches a process that is stuck but still
 *   printing.
 *
 * Expiry signals the child's whole process group (SIGTERM, then SIGKILL).
 * A run settles when the process dies, not when its pipes close, since a
 * grandchild can hold them open; a normal exit waits briefly for the output
 * tail.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { pipeToServerLog, serverLog } from '#log'

/** Budgets read in whole seconds, except the sub-second ones tests use. */
function humanMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`
}

/** Grace between the SIGTERM and the SIGKILL a wedged child cannot ignore. */
const KILL_GRACE_MS = 5_000

/** Bound on the kill sequence, for a process that survives SIGKILL
 *  (uninterruptible IO). */
const KILL_DEADLINE_MS = 30_000

/** How long a finished run waits for its pipes to drain (a grandchild may
 *  hold them open) before reporting its exit code. */
const PIPE_DRAIN_MS = 2_000

interface StreamingProcOptions {
  /** Piped to the child's stdin (a context tar); no stdin without it. */
  input?: NodeJS.ReadableStream
  onLog?: (line: string) => void
  logPrefix: string
  /**
   * Silence budget: killed after this long producing no output (and, while
   * `input` is still flowing, accepting none). Omit for no idle bound.
   */
  idleTimeoutMs?: number
  /** Hard cap on the whole run, however much it is saying. */
  timeoutMs: number
  /** Names the command in failures, e.g. `podman build`. */
  label: string
  /** Quote this many trailing output lines in failures (0 = none). */
  tailLines?: number
  /** The live child, right after spawn — for pid tracking. */
  onSpawn?: (child: ChildProcess) => void
  /**
   * Fires when the process is dead, before the promise settles. Called from
   * whichever of `exit`/`close` lands first, so it must be idempotent.
   */
  onExit?: () => void
}

/**
 * Run a command, streaming its output lines to the server log and `onLog`.
 * Resolves on exit 0; rejects on any other exit, a spawn error, or a
 * timeout.
 */
export async function runStreamingProcess(
  file: string,
  args: string[],
  opts: StreamingProcOptions,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // Own process group, so a kill also reaches grandchildren holding the
    // image-store lock.
    const child = spawn(file, args, {
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      detached: true,
    })
    opts.onSpawn?.(child)

    const tail: string[] = []
    const onLine = (line: string): void => {
      if (opts.tailLines) {
        tail.push(line)
        if (tail.length > opts.tailLines) tail.shift()
      }
      opts.onLog?.(line)
    }
    pipeToServerLog(child.stdout, opts.logPrefix, onLine)
    pipeToServerLog(child.stderr, opts.logPrefix, onLine)

    const quotedTail = (): string => (tail.length ? `:\n${tail.join('\n')}` : '')
    const timers: NodeJS.Timeout[] = []
    const arm = (ms: number, fn: () => void): NodeJS.Timeout => {
      const timer = setTimeout(fn, ms)
      timers.push(timer)
      return timer
    }

    let settled = false
    const finish = (err: Error | null): void => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimeout(timer)
      if (err) reject(err)
      else resolve()
    }

    /** Set once a budget expires: the reason, and the verdict for `exit`. */
    let expiry: string | null = null
    const onExpired = (why: string): void => {
      if (expiry) return
      expiry = why
      serverLog(`${opts.logPrefix}${why} — killing ${file}`)
      // Arm both timers first: a child dying on SIGTERM settles inside
      // `killGroup`, and a later timer would never be cleared.
      arm(KILL_GRACE_MS, () => killGroup(child, 'SIGKILL'))
      arm(KILL_DEADLINE_MS, () => finish(new Error(
        `${opts.label} ${why} and survived SIGKILL — it may still be running`
        + quotedTail(),
      )))
      killGroup(child, 'SIGTERM')
    }

    const idleMs = opts.idleTimeoutMs
    const idleTimer = idleMs === undefined
      ? null
      : arm(idleMs, () => onExpired(`produced no output for ${humanMs(idleMs)}`))
    arm(opts.timeoutMs, () => onExpired(`still running after ${humanMs(opts.timeoutMs)}`))

    // Accepted input counts as progress (`tar -x` prints nothing). Skip once
    // killed, since `refresh()` would re-arm the fired timer.
    const bump = (): void => { if (!expiry) idleTimer?.refresh() }
    child.stdout?.on('data', bump)
    child.stderr?.on('data', bump)

    if (opts.input !== undefined && child.stdin) {
      // EPIPE if the child exits early; the exit code decides.
      child.stdin.on('error', () => {})
      opts.input.on('data', bump)
      opts.input.pipe(child.stdin)
    }

    /** How the run ended, from the process's own exit status. */
    const verdict = (code: number | null, signal: NodeJS.Signals | null): Error | null => {
      if (code === 0) return null
      if (code === null) return new Error(`${opts.label} was killed by ${signal}${quotedTail()}`)
      return new Error(`${opts.label} exited with code ${code}${quotedTail()}`)
    }

    // Either event may come last; a grandchild can delay `close`
    // indefinitely.
    child.on('exit', (code, signal) => {
      opts.onExit?.()
      // A killed run ends when the process does.
      if (expiry) finish(new Error(`${opts.label} ${expiry}${quotedTail()}`))
      else arm(PIPE_DRAIN_MS, () => finish(verdict(code, signal)))
    })
    child.on('close', (code, signal) => {
      opts.onExit?.()
      if (!expiry) finish(verdict(code, signal))
    })
    child.on('error', (err) => {
      opts.onExit?.()
      finish(err)
    })
  })
}

/** Signal the child's process group, else the child alone. Best-effort. */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  // A pid of 0 would signal this server's own process group.
  if (pid === undefined || pid <= 0) return
  // Reaped: the pid may have been reused, and `process.kill` would not know.
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // already gone
    }
  }
}
