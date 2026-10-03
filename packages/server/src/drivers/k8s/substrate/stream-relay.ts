import net from 'node:net'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { WorkspaceExecError, type StreamChild } from '#drivers/contract'
import { FRAME_DATA, FRAME_EXIT, FRAME_RESIZE, FRAME_SIGNAL, FrameParser, encodeFrame } from '@yaac/shared/stream-frames'
import { k8sNamespace, readObject } from './api'
import { workspaceIdFromJobName } from './pods'
import { containerExec } from './exec'
import {
  PROXY_AUTH_SECRET_NAME,
  RELAY_PORT,
  proxyServiceHost,
} from './proxy-constants'

/**
 * Server side of the stream relay (docs/stream-relay.md). All steady-state
 * traffic between the server and a workspace pod (terminal PTYs, the status
 * watcher's tmux control stream, forwarded TCP, one-shot commands) goes over
 * a plain TCP connection through the proxy's relay listener to the pod's
 * streamd, bypassing the apiserver. kubectl exec is used only where
 * streamd may not be running (`bootStreamd`, the teardown-time image-salvage
 * survey) and for non-workspace pods.
 *
 * Each stream starts with a relay auth line
 * `{token: <proxyAuthSecret>, workspaceId}` and a streamd handshake line
 * `{token: <per-workspace HMAC>, kind, ...params}`, sent together. streamd
 * replies `{ok}`, then the payload follows. After the auth line the relay
 * just splices bytes.
 */

/** Dial + handshake deadline for a new stream. */
const DIAL_TIMEOUT_MS = 15_000
/**
 * Minimum `podExec` budget, and so minimum dial deadline. The dial deadline
 * describes the shared transport, not one caller's patience: the stale
 * reaper's tmux probes ask for 2s (runtime/status/liveness.ts), but a dial
 * through the proxy can take longer on a host busy building images, and a
 * slow dial must not be mistaken for a dead relay.
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
 * The relay address: the proxy's Service, dialed pod-to-pod since the
 * server runs in the same namespace (docs/server-in-cluster.md).
 */
function resolveRelayAddr(): RelayAddr {
  const addr = proxyServiceHost(k8sNamespace(), RELAY_PORT)
  const idx = addr.lastIndexOf(':')
  return { host: addr.slice(0, idx), port: Number.parseInt(addr.slice(idx + 1), 10) }
}

/**
 * The install's proxy auth secret: the proxy's control-API key, the relay
 * bearer token, and the HMAC key for per-workspace stream tokens. Null
 * before the proxy's first deploy creates it.
 */
export async function readProxyAuthSecret(): Promise<string | null> {
  const secret = await readObject<{ data?: Record<string, string> }>({
    apiVersion: 'v1', kind: 'Secret', name: PROXY_AUTH_SECRET_NAME, namespace: k8sNamespace(),
  })
  const encoded = secret?.data?.secret
  return encoded ? Buffer.from(encoded, 'base64').toString('utf8') : null
}

/** `readProxyAuthSecret`, read once per server run: it is never rotated in
 *  place. */
async function relaySecret(): Promise<string> {
  cachedSecret ??= await readProxyAuthSecret()
  if (!cachedSecret) throw new Error('stream relay: proxy auth secret not found — is the proxy deployed?')
  return cachedSecret
}

/**
 * A workspace's streamd token: HMAC-SHA256(proxyAuthSecret, workspaceId).
 * Derived (never stored), so it survives server restarts; workspace-create
 * injects it into the pod as YAAC_STREAM_TOKEN.
 */
export async function podStreamToken(workspaceId: string): Promise<string> {
  const secret = await relaySecret()
  return crypto.createHmac('sha256', secret).update(workspaceId).digest('hex')
}

/**
 * Transport failure (relay unreachable, handshake refused, timeout, missing
 * reply). Unlike WorkspaceExecError it says nothing about the command's outcome.
 */
export class RelayDialError extends Error {
  constructor(
    message: string,
    /**
     * True when the transport failed after streamd received the command
     * (reply timeout, socket drop). The command may have run, so `podExec`
     * does not retry, sparing non-idempotent commands a duplicate run.
     */
    readonly afterDispatch = false,
  ) {
    super(message)
  }
}

/**
 * Open one stream to a workspace's streamd: dial the relay, send the auth
 * and handshake lines, and wait for streamd's `{ok}` reply. Resolves with
 * the socket paused, with any bytes past the reply line unshifted. Rejects
 * with RelayDialError on any failure. Each stream dials independently, so
 * one failure affects only that stream.
 */
export async function relayDial(
  workspaceId: string,
  handshake: Record<string, unknown>,
  opts: { timeoutMs?: number } = {},
): Promise<net.Socket> {
  const timeoutMs = opts.timeoutMs ?? DIAL_TIMEOUT_MS
  const addr = resolveRelayAddr()
  const [secret, token] = await Promise.all([
    relaySecret(),
    podStreamToken(workspaceId),
  ]).catch((err: unknown) => {
    throw new RelayDialError(`stream relay: ${err instanceof Error ? err.message : String(err)}`)
  })

  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect(addr.port, addr.host)
    // Latency-sensitive callers already batch their writes, so Nagle would
    // only add delay.
    socket.setNoDelay(true)
    let settled = false
    let buf = Buffer.alloc(0)

    const fail = (reason: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      reject(new RelayDialError(`stream relay dial (${workspaceId.slice(0, 8)}...): ${reason}`))
    }
    const timer = setTimeout(() => fail(`timeout after ${timeoutMs}ms`), timeoutMs)

    socket.on('error', (err: Error) => fail(err.message))
    socket.on('close', () => fail('connection closed during handshake'))
    socket.on('connect', () => {
      socket.write(
        JSON.stringify({ token: secret, workspaceId }) + '\n'
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
      // Keep a no-op error listener so an error before the consumer attaches
      // its own cannot crash the process.
      socket.on('error', () => { /* consumer-owned */ })
      socket.pause()
      const rest = buf.subarray(nl + 1)
      if (rest.length > 0) socket.unshift(rest)
      resolve(socket)
    }
    socket.on('data', onData)
  })
}

// ── One-shot commands ──────────────────────────────────────────────────────

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

interface RelayExecOptions {
  /**
   * Overall deadline (dial + run). Default 30s. The dial is capped at
   * DIAL_TIMEOUT_MS regardless, so a long budget cannot turn a hung
   * transport into a long stall. Values below MIN_EXEC_TIMEOUT_MS are
   * raised to it.
   */
  timeout?: number
  /**
   * Dial-failure retries. Default 3. Nonzero exits and failures after
   * dispatch are never retried, since the command ran.
   */
  maxAttempts?: number
}

/**
 * Run a shell command in a workspace pod through its streamd (as
 * `sh -c <cmd>`). Resolves `{stdout, stderr}` on exit 0; throws
 * WorkspaceExecError on a nonzero exit and RelayDialError when the pod was not
 * reached. Only the dial is retried: once streamd has the command, any
 * failure is final so a non-idempotent command is never run twice.
 */
export async function podExec(
  jobName: string,
  cmd: string,
  opts: RelayExecOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const workspaceId = workspaceIdFromJobName(jobName)
  const timeoutMs = Math.max(MIN_EXEC_TIMEOUT_MS, opts.timeout ?? 30_000)
  const maxAttempts = opts.maxAttempts ?? 3
  let lastErr: Error = new RelayDialError('no attempts made')
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const started = Date.now()
    try {
      // `timeout` budgets the command; the dial gets its own shorter cap so
      // a hung transport fails fast on each attempt.
      const socket = await relayDial(
        workspaceId,
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
        // streamd accepted the handshake, so the command may have run.
        throw new RelayDialError('malformed exec result', true)
      }
      const { exitCode, stdout = '', stderr = '', signal, spawnFailed } = result
      // Only a real exit is a verdict about the pod: the reaper treats a
      // WorkspaceExecError as `dead` and tears the workspace down. A signal
      // kill, a spawn failure, or a result with no exit code (all common
      // under in-pod memory pressure) are reported as transport failures
      // instead, which callers keep rather than reap. They are marked
      // `afterDispatch` because the command may have run.
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
      throw new WorkspaceExecError(
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
 * The contract's `StreamChild` over a `ctrl` stream. Returned synchronously;
 * writes before the dial completes are buffered, and a dial failure is
 * emitted as 'error'.
 */
export function dialCtrlStream(workspaceId: string, argv: string[]): StreamChild {
  const emitter = new EventEmitter()
  const dataCbs: Array<(chunk: Buffer | string) => void> = []
  const pending: string[] = []
  let sock: net.Socket | null = null
  let killed = false

  relayDial(workspaceId, { kind: 'ctrl', cmd: argv }).then(
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
 * PTY-like surface over a `pty` stream (matches pty-bridge's PtyLike).
 * `kill()` with no signal drops the stream, and streamd kills the child on
 * socket close; `kill(name)` sends an in-band signal frame.
 */
export interface StreamPty {
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

export function dialPtyStream(
  workspaceId: string,
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

  relayDial(workspaceId, {
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
        // Merge consecutive data frames into one callback (one WebSocket
        // message) so a redraw split by TCP reaches the terminal as a single
        // write.
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
      // The PTY surface has no error channel, so a failed dial is an exit;
      // the frontend's reconnect loop retries.
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
 * Start (or restart) streamd in a workspace pod over kubectl exec, which
 * works even when no stream can reach the pod. Idempotent: a second daemon
 * exits on EADDRINUSE. Used by workspace setup and the status watcher's
 * self-heal.
 */
export async function bootStreamd(
  jobName: string,
  /** Deadline for the kubectl exec; waitForStreamd passes its remaining budget. */
  opts: { timeout?: number } = {},
): Promise<void> {
  await containerExec(
    jobName,
    `sh -c 'setsid node /opt/yaac/streamd/main.js >>/tmp/streamd.log 2>&1 </dev/null &'`,
    { timeout: opts.timeout ?? 15_000 },
  )
}

/** Test seam for waitForStreamd (the module's own exec/boot functions). */
export interface WaitForStreamdDeps {
  exec: typeof podExec
  boot: typeof bootStreamd
  sleepMs: (ms: number) => Promise<void>
}

/**
 * Wait until a workspace pod's streamd answers over the relay. Used as the
 * "in-pod setup done" signal on create and before a prewarm claim mutates a
 * spare. yaac-workspace-init starts streamd last, so a successful exec
 * proves git config and tmux are in place.
 *
 * Dial failures are retried until the deadline, since the proxy may not
 * know the pod IP yet right after Ready. Once, at the halfway mark or at
 * expiry (whichever is first reached), `bootStreamd` restarts the daemon,
 * capped at the remaining budget, so a streamd that failed to start still
 * recovers even under a short budget.
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
      // A non-dial error means streamd is up but the command failed.
      if (!(err instanceof RelayDialError)) throw err
      const expired = Date.now() >= deadline
      if (!healed && (expired || Date.now() >= deadline - timeoutMs / 2)) {
        healed = true
        // Never zero: even an expired budget gets one boot and one probe.
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
