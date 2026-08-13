/**
 * The child-process runner for yaac's long, chatty subprocesses: `podman
 * build` / `podman push` on the host engine, and `kubectl exec` into a
 * builder pod. One place owns the two things they all need — their output
 * streamed to the server log while it happens, and a way to be stopped that
 * survives the process not cooperating.
 *
 * Two budgets, because neither alone is enough:
 *
 * - **idle** (`idleTimeoutMs`, optional) — restarted by every byte the child
 *   writes, and every byte we feed its stdin. This is the primary signal for
 *   a build: a cold chain compiling a toolchain legitimately runs many times
 *   longer than a warm rebuild, so a total cap kills exactly the builds that
 *   most needed to finish, mid-progress, after the expensive part. Silence
 *   does not have that problem — podman emits a line per step, per pulled
 *   layer and per progress tick.
 * - **total** (`timeoutMs`, required) — the backstop for what idle cannot
 *   see: a process that is wedged but chatty (a RUN step retrying in a loop,
 *   a download stuck at 3% still ticking) never goes silent, and would
 *   otherwise run forever holding whatever lock it holds.
 *
 * Either expiry signals the child's whole process group — it is spawned into
 * its own, so the grandchildren a build spawns cannot outlive it —
 * escalating SIGTERM -> SIGKILL.
 *
 * Every run settles on the process's death, not on its pipes: a grandchild
 * that inherited the stdio can hold `close` open long after the process is
 * gone, and neither a kill's verdict nor an exit code may wait on that.
 * Callers that serialize on "is podman done?" need the process. A run that
 * ends on its own does give `close` a few seconds to land first, since that
 * is the difference between a complete output tail and a truncated one.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { pipeToServerLog, serverLog } from '#log'

/** Budgets read in whole seconds, except the sub-second ones tests use. */
function humanMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`
}

/** Grace between the SIGTERM and the SIGKILL a wedged child cannot ignore. */
const KILL_GRACE_MS = 5_000

/**
 * Bound on the whole kill sequence. Reached only by a process that survived
 * SIGKILL (uninterruptible IO), where waiting on would strand the caller for
 * as long as the kernel does.
 */
const KILL_DEADLINE_MS = 30_000

/**
 * How long a finished run waits for its pipes to drain before reporting the
 * verdict it already has. Normally `close` lands within a tick of `exit` and
 * this never fires; it only bounds the case where a grandchild inherited the
 * pipes and holds them open — which must not postpone, or invert, the
 * process's own exit code.
 */
const PIPE_DRAIN_MS = 2_000

export interface StreamingProcOptions {
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
 * Run a command, streaming its stdout/stderr lines to the server log and to
 * `onLog` (e.g. the build-tracking registry). Uses spawn rather than the
 * buffered exec helpers because the output is unbounded and must stream.
 * Resolves on exit code 0; rejects on any other exit, on a spawn error, and
 * on either timeout.
 */
export async function runStreamingProcess(
  file: string,
  args: string[],
  opts: StreamingProcOptions,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // Own process group: a build's grandchildren (buildah, the RUN step's
    // container) must die with it, or they keep holding the image-store lock
    // the kill was meant to release.
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
      // Both follow-ups are armed before the first signal: a child that dies
      // on SIGTERM settles synchronously from within `killGroup`, and a
      // timer armed after that would never be cleared.
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

    // Progress is any byte out — or, while we are still feeding input, any
    // byte accepted: `tar -x` prints nothing on success, so the bytes going
    // in are all the liveness that step has. (`refresh()` re-arms an
    // already-fired timer, so a killed child's trailing output must not
    // reach it.)
    const bump = (): void => { if (!expiry) idleTimer?.refresh() }
    child.stdout?.on('data', bump)
    child.stderr?.on('data', bump)

    if (opts.input !== undefined && child.stdin) {
      // The remote side can exit before consuming all input (a failed
      // extract) — swallow the EPIPE; the exit code carries the verdict.
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

    // Both handlers are wired because either can be the last word: `close`
    // normally lands a tick after `exit`, but a grandchild that inherited
    // the stdio pipes can hold it back indefinitely. Nothing about a process
    // that is already gone may wait on that.
    child.on('exit', (code, signal) => {
      opts.onExit?.()
      // A killed run is over the moment the process is: whatever still holds
      // the pipes open is no longer this run's problem, and its trailing
      // output keeps landing in the server log regardless.
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

/**
 * Signal the child's whole process group, falling back to the child alone if
 * the group is already gone. Best-effort: every caller is on a path that is
 * already failing.
 */
export function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  // A pid of 0 would signal this server's own process group.
  if (pid === undefined || pid <= 0) return
  // Already reaped: unlike `child.kill`, a raw `process.kill` has no guard
  // against the pid having been handed to something else since.
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
