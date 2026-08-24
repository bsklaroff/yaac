import net from 'node:net'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { env } from '@yaac/shared/env'
import { FRAME_DATA, FRAME_EXIT, FRAME_RESIZE, FRAME_SIGNAL, FrameParser, encodeFrame } from '@yaac/shared/stream-frames'
import { k8sNamespace, kubectlGetJson } from './kubectl'
import { worktreeIdFromJobName } from './pods'
import { containerExec } from './exec'
import {
  PROXY_AUTH_SECRET_NAME,
  RELAY_PORT,
  proxyServiceHost,
} from './proxy-constants'

/**
 * The server side of the stream relay (docs/stream-relay.md): every
 * steady-state byte between the server and a worktree pod — terminal PTYs,
 * the status watcher's tmux control stream, forwarded TCP, one-shot pod
 * commands — rides a plain TCP connection through the proxy's relay
 * listener into the pod's streamd, entirely off the apiserver. kubectl
 * exec survives only where streamd cannot be gated on — `bootStreamd`,
 * the teardown-time image-salvage survey — and for non-worktree infra pods.
 *
 * Wire shape per stream: one relay auth line
 * `{token: <proxyAuthSecret>, worktreeId}`, then one streamd handshake
 * line `{token: <per-worktree HMAC>, kind, ...params}`, then streamd's
 * `{ok}` reply line, then the payload. Both lines are pipelined in one
 * write; the relay is a dumb splice after its auth line.
 */

/** Dial + handshake deadline for a new stream. */
const DIAL_TIMEOUT_MS = 15_000
/**
 * Floor on a `podExec` budget, and so on the dial deadline derived
 * from it. A dial deadline is a statement about the TRANSPORT — which
 * every worktree's streams share — not about how fast one caller wants an
 * answer, and the two must not be the same number. The stale reaper's
 * tmux probes ask for 2s (features/status/liveness.ts); a dial that
 * crosses the apiserver, the proxy and a pod dial can legitimately take
 * longer than that on a host busy building images, and a probe's
 * impatience must never be read as a dead relay.
 */
const MIN_EXEC_TIMEOUT_MS = 5_000
/** Reply-line cap (it is one small JSON object). */
const REPLY_MAX_BYTES = 16 * 1024

interface RelayAddr {
  host: string
  port: number
}

let cachedSecret: string | null = null

/** Test-only: reset all module caches. */
export function _resetRelayCacheForTests(): void {
  cachedSecret = null
}

/**
 * Where this install's relay listens: the proxy's Service, in-cluster.
 *
 * A plain pod-to-pod dial, because the server is a pod of the same
 * namespace (docs/server-in-cluster.md) and the proxy's ingress policy
 * admits its selector on this port. `YAAC_RELAY_ADDR` is what the
 * Deployment states it as, and it is honoured verbatim so a differently
 * shaped install can point the relay somewhere else without touching code.
 *
 * The default is derived rather than required, so a server started by hand
 * against a cluster whose proxy sits where it always does still resolves —
 * and a server that is NOT in the cluster gets a name that does not
 * resolve, which is the honest answer for a placement this driver no
 * longer has.
 */
function resolveRelayAddr(): RelayAddr {
  if (env.relayAddr) return env.relayAddr
  const addr = proxyServiceHost(k8sNamespace(), RELAY_PORT)
  const idx = addr.lastIndexOf(':')
  return { host: addr.slice(0, idx), port: Number.parseInt(addr.slice(idx + 1), 10) }
}

/**
 * The install's proxy auth secret — the relay bearer and the HMAC key for
 * per-worktree stream tokens. Read once per server run (it is generated
 * once per cluster and never rotated in place).
 */
async function relaySecret(): Promise<string> {
  if (cachedSecret) return cachedSecret
  const secret = await kubectlGetJson<{ data?: Record<string, string> }>([
    'get', 'secret', PROXY_AUTH_SECRET_NAME, '-n', k8sNamespace(),
  ])
  const encoded = secret?.data?.secret
  if (!encoded) throw new Error('stream relay: proxy auth secret not found — is the proxy deployed?')
  cachedSecret = Buffer.from(encoded, 'base64').toString('utf8')
  return cachedSecret
}

/**
 * A worktree's streamd token: HMAC-SHA256(proxyAuthSecret, worktreeId).
 * Derived (never stored), so it survives server restarts; worktree-create
 * injects it into the pod as YAAC_STREAM_TOKEN.
 */
export async function podStreamToken(worktreeId: string): Promise<string> {
  const secret = await relaySecret()
  return crypto.createHmac('sha256', secret).update(worktreeId).digest('hex')
}

/** Transport-level failure (relay unreachable, refused handshake,
 *  timeout, a reply that never arrived) — never a verdict on the
 *  command's outcome, unlike RelayExecError. Whether the command
 *  nonetheless *ran* is `afterDispatch`. */
export class RelayDialError extends Error {
  constructor(
    message: string,
    /**
     * True when the transport failed AFTER the command was handed to
     * streamd — a reply-read timeout, or the socket dropping mid-read.
     * The pod may well have run the command, so re-issuing it is a
     * *re-run*, not a retry: `podExec` stops retrying on these, and
     * a caller whose command isn't idempotent is spared a duplicate.
     */
    readonly afterDispatch = false,
  ) {
    super(message)
  }
}

/**
 * Open one stream to a worktree's streamd: dial the relay, pipeline the
 * relay auth line + streamd handshake line, await streamd's `{ok}` reply.
 * Resolves with the connected socket, paused, with any bytes past the
 * reply line unshifted. Rejects with RelayDialError on any failure.
 *
 * Every stream dials the proxy Service independently, so one stream's
 * failure is one stream's failure — there is no shared child process left
 * for a bad dial to condemn, and no `sawReplyBytes` bookkeeping deciding
 * whether to condemn it.
 */
export async function relayDial(
  worktreeId: string,
  handshake: Record<string, unknown>,
  opts: { timeoutMs?: number } = {},
): Promise<net.Socket> {
  const timeoutMs = opts.timeoutMs ?? DIAL_TIMEOUT_MS
  const addr = resolveRelayAddr()
  const [secret, token] = await Promise.all([
    relaySecret(),
    podStreamToken(worktreeId),
  ]).catch((err: unknown) => {
    throw new RelayDialError(`stream relay: ${err instanceof Error ? err.message : String(err)}`)
  })

  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect(addr.port, addr.host)
    // Nagle would hold a small write back waiting for more, and every stream
    // that cares about latency here already coalesces deliberately (the
    // output batcher at both ends, the keystroke batcher in the browser). All
    // it can add on top of that is delay — up to a delayed-ACK interval per
    // write, spending the batcher's whole 8ms budget in the kernel.
    socket.setNoDelay(true)
    let settled = false
    let buf = Buffer.alloc(0)

    const fail = (reason: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      reject(new RelayDialError(`stream relay dial (${worktreeId.slice(0, 8)}...): ${reason}`))
    }
    const timer = setTimeout(() => fail(`timeout after ${timeoutMs}ms`), timeoutMs)

    socket.on('error', (err: Error) => fail(err.message))
    socket.on('close', () => fail('connection closed during handshake'))
    socket.on('connect', () => {
      socket.write(
        JSON.stringify({ token: secret, worktreeId }) + '\n'
        + JSON.stringify({ token, ...handshake }) + '\n',
      )
    })
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk])
      const nl = buf.indexOf(0x0a)
      if (nl < 0) {
        if (buf.length > REPLY_MAX_BYTES) fail('oversized handshake reply')
        return
      }
      let reply: { ok?: boolean; error?: string }
      try {
        reply = JSON.parse(buf.subarray(0, nl).toString('utf8')) as typeof reply
      } catch {
        fail('malformed handshake reply')
        return
      }
      if (reply.ok !== true) {
        fail(`refused: ${reply.error ?? 'unknown error'}`)
        return
      }
      settled = true
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeAllListeners('error')
      socket.removeAllListeners('close')
      // Keep a no-op error listener so an error firing before the consumer
      // attaches its own can't crash the process; consumers' listeners
      // coexist with it.
      socket.on('error', () => { /* consumer-owned */ })
      socket.pause()
      const rest = buf.subarray(nl + 1)
      if (rest.length > 0) socket.unshift(rest)
      resolve(socket)
    }
    socket.on('data', onData)
  })
}

// ── One-shot commands (the containerExec replacement for worktree pods) ──────

/** The remote command ran and exited nonzero — a conclusive verdict about
 *  the pod (unlike RelayDialError). Mirrors child_process error fields
 *  (`stderr`, `code`) so existing message/classification code ports over. */
export class RelayExecError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message)
  }
}

/** Read a whole (already-handshaken) stream to its end. */
function readAll(socket: net.Socket, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new RelayDialError(`stream read timeout after ${timeoutMs}ms`, true))
    }, timeoutMs)
    socket.on('data', (c: Buffer) => chunks.push(c))
    socket.on('error', (err: Error) => {
      clearTimeout(timer)
      reject(new RelayDialError(err.message, true))
    })
    socket.on('close', () => {
      clearTimeout(timer)
      resolve(Buffer.concat(chunks))
    })
    socket.resume()
  })
}

export interface RelayExecOptions {
  /**
   * Overall deadline (dial + run). Default 30s. Widen it for a command
   * that legitimately runs long — the *dial* stays capped at
   * DIAL_TIMEOUT_MS regardless, so a long budget can't turn a hung
   * transport into a multi-minute stall. Narrowing it past
   * MIN_EXEC_TIMEOUT_MS has no effect: below that the number stops being
   * a preference and starts being a verdict on the shared relay.
   */
  timeout?: number
  /** Dial-failure retries. Neither a clean nonzero exit nor a failure
   *  past dispatch is retried — in both cases the command ran. Default 3. */
  maxAttempts?: number
}

/**
 * Run a shell command inside a worktree pod via its streamd — the drop-in
 * replacement for `containerExec` on worktree pods. `cmd` is a
 * shell-formatted command tail (executed as `sh -c <cmd>` in the pod —
 * one shell pass, like the host-shell pass `containerExec` gave it).
 * Resolves `{stdout, stderr}` on exit 0; throws RelayExecError on a
 * nonzero exit and RelayDialError when the pod was never reached.
 *
 * Retries cover only the dial: once streamd has the command, a failure
 * (nonzero exit, or a `afterDispatch` transport drop) is final, so a
 * non-idempotent command can't be issued twice behind the caller's back.
 */
export async function podExec(
  jobName: string,
  cmd: string,
  opts: RelayExecOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const worktreeId = worktreeIdFromJobName(jobName)
  const timeoutMs = Math.max(MIN_EXEC_TIMEOUT_MS, opts.timeout ?? 30_000)
  const maxAttempts = opts.maxAttempts ?? 3
  let lastErr: Error = new RelayDialError('no attempts made')
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const started = Date.now()
    try {
      // The dial gets its own (bounded) deadline: `timeout` is the budget
      // for the COMMAND, and letting it govern the dial too would make a
      // hung transport cost `timeout` per attempt before anyone notices.
      const socket = await relayDial(
        worktreeId,
        { kind: 'exec', cmd: ['sh', '-c', cmd] },
        { timeoutMs: Math.min(DIAL_TIMEOUT_MS, timeoutMs) },
      )
      const body = await readAll(socket, Math.max(1, timeoutMs - (Date.now() - started)))
      let result: {
        exitCode?: number
        stdout?: string
        stderr?: string
        /** Set when the child was killed rather than exiting on its own. */
        signal?: string
        /** Set when streamd could not spawn the command at all. */
        spawnFailed?: boolean
      }
      try {
        result = JSON.parse(body.toString('utf8')) as typeof result
      } catch {
        // Dispatched: streamd answered the handshake, so whatever came
        // back (truncated, empty, garbage) followed a command that ran.
        throw new RelayDialError('malformed exec result', true)
      }
      const { exitCode, stdout = '', stderr = '', signal, spawnFailed } = result
      // Only a command that RAN AND EXITED is a verdict about the pod, and
      // the difference deletes worktrees: a RelayExecError reads as `dead`
      // at the reaper, which tears the worktree down in the same pass. Three
      // results say the command did not get that far, and each would
      // otherwise land as a nonzero exit — a signal kill reports no code (so
      // the `?? 1` in streamd stands in for one), a spawn failure fabricates
      // 127, and a truncated result carries no code at all. In-pod memory
      // pressure produces the first two AND downs the status stream that
      // would otherwise have answered liveness without any probe, so they
      // arrive together rather than independently.
      //
      // `afterDispatch` on all three: the command may have run, so a retry
      // could issue a non-idempotent one twice. They surface as transport
      // failures, which every consumer keeps rather than reaps.
      if (spawnFailed) {
        throw new RelayDialError(`streamd could not spawn the command in ${jobName}: ${stderr.trim()}`, true)
      }
      if (signal !== undefined) {
        throw new RelayDialError(`command killed by ${signal} in ${jobName}`, true)
      }
      if (exitCode === undefined) {
        throw new RelayDialError(`exec result carried no exit code in ${jobName}`, true)
      }
      if (exitCode === 0) return { stdout, stderr }
      throw new RelayExecError(
        `command exited ${exitCode} in ${jobName}: ${stderr.trim() || stdout.trim()}`,
        exitCode, stdout, stderr,
      )
    } catch (err) {
      lastErr = err as Error
      if (
        !(err instanceof RelayDialError)
        || err.afterDispatch
        || attempt === maxAttempts
      ) throw err
      await new Promise((r) => setTimeout(r, 250 * attempt))
    }
  }
  throw lastErr
}

// ── Stream adapters (sync facades over the async dial) ─────────────────────

/**
 * Child-process-shaped surface over a `ctrl` stream — what the status
 * watcher's `spawnAttach` seam expects (structurally AttachChild). The
 * facade exists synchronously; writes made before the dial completes are
 * buffered, and a dial failure surfaces as an 'error' event.
 */
export interface StreamChild {
  stdin: { write(data: string): void } | null
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null
  stderr: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null
  on(event: 'exit' | 'error', cb: (...args: unknown[]) => void): void
  kill(signal?: NodeJS.Signals): boolean
}

export function dialCtrlStream(worktreeId: string, argv: string[]): StreamChild {
  const emitter = new EventEmitter()
  const dataCbs: Array<(chunk: Buffer | string) => void> = []
  const pending: string[] = []
  let sock: net.Socket | null = null
  let killed = false

  relayDial(worktreeId, { kind: 'ctrl', cmd: argv }).then(
    (socket) => {
      if (killed) {
        socket.destroy()
        return
      }
      sock = socket
      socket.on('data', (chunk: Buffer) => {
        for (const cb of dataCbs) cb(chunk)
      })
      socket.on('error', () => { /* 'close' follows and emits exit */ })
      socket.on('close', () => emitter.emit('exit'))
      for (const d of pending) socket.write(d)
      pending.length = 0
      socket.resume()
    },
    (err: Error) => {
      if (!killed) emitter.emit('error', err)
    },
  )

  return {
    stdin: {
      write: (data) => {
        if (sock) sock.write(data)
        else pending.push(data)
      },
    },
    stdout: { on: (_event, cb) => { dataCbs.push(cb) } },
    stderr: { on: () => { /* streamd ctrl carries no stderr */ } },
    on: (event, cb) => { emitter.on(event, cb) },
    kill: () => {
      killed = true
      sock?.destroy()
      return true
    },
  }
}

/**
 * PTY-shaped surface over a `pty` stream (structurally the pty-bridge's
 * PtyLike). Frames are decoded/encoded with the shared codec; `kill()`
 * with no signal drops the stream (streamd kills the child on socket
 * close), `kill(name)` sends an in-band signal frame.
 */
export interface StreamPty {
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

export function dialPtyStream(
  worktreeId: string,
  argv: string[],
  size: { cols?: number; rows?: number },
): StreamPty {
  const dataCbs: Array<(data: string) => void> = []
  const exitCbs: Array<(e: { exitCode: number }) => void> = []
  const pending: Buffer[] = []
  let sock: net.Socket | null = null
  let killed = false
  let exitEmitted = false
  let exitCode: number | null = null

  const emitExit = (code: number): void => {
    if (exitEmitted) return
    exitEmitted = true
    for (const cb of exitCbs) cb({ exitCode: code })
  }
  const send = (frame: Buffer): void => {
    if (sock) sock.write(frame)
    else if (!killed) pending.push(frame)
  }

  relayDial(worktreeId, {
    kind: 'pty',
    cmd: argv,
    cols: size.cols ?? 80,
    rows: size.rows ?? 24,
  }).then(
    (socket) => {
      if (killed) {
        socket.destroy()
        return
      }
      sock = socket
      const parser = new FrameParser()
      socket.on('data', (chunk: Buffer) => {
        let frames
        try {
          frames = parser.feed(chunk)
        } catch {
          socket.destroy()
          return
        }
        // Consecutive data frames in one chunk dispatch as ONE callback:
        // each callback becomes a WebSocket message to the browser, and a
        // redraw burst split across frames should reach the terminal as a
        // single write it can paint atomically (streamd batches at the
        // source; this collapses whatever TCP re-fragments en route).
        let text = ''
        const flushText = (): void => {
          if (text === '') return
          const t = text
          text = ''
          for (const cb of dataCbs) cb(t)
        }
        for (const f of frames) {
          if (f.type === FRAME_DATA) {
            text += f.payload.toString('utf8')
          } else if (f.type === FRAME_EXIT) {
            flushText() // ordering: output precedes the exit
            try {
              exitCode = (JSON.parse(f.payload.toString('utf8')) as { code?: number }).code ?? 0
            } catch {
              exitCode = 1
            }
            emitExit(exitCode)
          }
        }
        flushText()
      })
      socket.on('error', () => { /* 'close' follows */ })
      socket.on('close', () => emitExit(exitCode ?? 1))
      for (const f of pending) socket.write(f)
      pending.length = 0
      socket.resume()
    },
    () => {
      // No error channel on the PTY surface — a failed dial is an exit;
      // the frontend's reconnect loop owns the retry.
      if (!killed) emitExit(1)
    },
  )

  return {
    onData: (cb) => { dataCbs.push(cb) },
    onExit: (cb) => { exitCbs.push(cb) },
    write: (data) => send(encodeFrame(FRAME_DATA, Buffer.from(data, 'utf8'))),
    resize: (cols, rows) => send(encodeFrame(FRAME_RESIZE, { cols, rows })),
    kill: (signal) => {
      if (signal) {
        send(encodeFrame(FRAME_SIGNAL, { name: signal }))
        return
      }
      killed = true
      pending.length = 0
      sock?.destroy()
    },
  }
}

// ── streamd lifecycle ──────────────────────────────────────────────────────

/**
 * Start (or restart) streamd in a worktree pod — the one steady-state
 * kubectl exec that remains, because it is what heals a crashed streamd
 * when no stream can reach the pod. Idempotent: a second daemon exits on
 * EADDRINUSE. Used by worktree-create's setup and the status watcher's
 * self-heal.
 */
export async function bootStreamd(
  jobName: string,
  /** Deadline for the kubectl exec. Callers on a budget (waitForStreamd)
   *  pass what is left of theirs so the heal can't overrun it. */
  opts: { timeout?: number } = {},
): Promise<void> {
  await containerExec(
    jobName,
    `sh -c 'setsid node /opt/yaac/streamd/main.js >>/tmp/streamd.log 2>&1 </dev/null &'`,
    { maxAttempts: 1, timeout: opts.timeout ?? 15_000 },
  )
}

/** Test seam for waitForStreamd (the module's own exec/boot functions). */
export interface WaitForStreamdDeps {
  exec: typeof podExec
  boot: typeof bootStreamd
  sleepMs: (ms: number) => Promise<void>
}

/**
 * Gate on a worktree pod's streamd answering the relay — worktree-create's
 * "in-pod setup done" signal, and the prewarm claim's readiness gate
 * before it mutates a spare. The pod's postStart hook (yaac-worktree-init)
 * starts streamd last, so a successful relay exec proves the git config and
 * tmux server it configured are in place, and every setup command that
 * follows can ride the relay instead of kubectl exec.
 *
 * Dial failures are retried until the deadline: right after pod-Ready the
 * proxy may not have observed the pod IP yet, and streamd's node process
 * takes a beat to bind. Halfway through the budget, `bootStreamd` re-runs
 * the daemon via kubectl exec once — the same self-heal the status watcher
 * uses — so a streamd that failed to start in the hook still recovers.
 *
 * The heal is checked BEFORE the deadline gives up, and its kubectl exec
 * is capped at what remains of the budget. Otherwise a short budget (the
 * claim path's 10s) could both overrun — the boot's own timeout is not
 * the caller's — and expire on a probe cycle that straddles the halfway
 * mark, throwing without ever attempting the one thing that heals it.
 */
export async function waitForStreamd(
  jobName: string,
  opts: { timeoutMs?: number } = {},
  deps?: WaitForStreamdDeps,
): Promise<void> {
  const d = deps ?? {
    exec: podExec,
    boot: bootStreamd,
    sleepMs: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  }
  const timeoutMs = opts.timeoutMs ?? 30_000
  const deadline = Date.now() + timeoutMs
  let healed = false
  for (;;) {
    try {
      await d.exec(jobName, 'true', { maxAttempts: 1, timeout: 5_000 })
      return
    } catch (err) {
      // A non-dial error means the pod ran the command — streamd is up but
      // something else is wrong; surface it.
      if (!(err instanceof RelayDialError)) throw err
      const expired = Date.now() >= deadline
      if (!healed && (expired || Date.now() >= deadline - timeoutMs / 2)) {
        healed = true
        // Bounded by what's left, but never zero: an expired budget still
        // buys one boot + one probe, which beats giving up un-healed.
        await d.boot(jobName, { timeout: Math.max(1_000, deadline - Date.now()) })
          .catch(() => { /* dial loop keeps trying */ })
        continue
      }
      if (expired) {
        throw new Error(
          `streamd in ${jobName} not reachable after ${timeoutMs}ms: ${err.message}`,
        )
      }
      await d.sleepMs(300)
    }
  }
}
