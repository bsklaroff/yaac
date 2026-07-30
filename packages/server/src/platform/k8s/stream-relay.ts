import net from 'node:net'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn, type ChildProcess } from 'node:child_process'
import { env } from '@yaac/shared/env'
import { FRAME_DATA, FRAME_EXIT, FRAME_RESIZE, FRAME_SIGNAL, FrameParser, encodeFrame } from '@yaac/shared/stream-frames'
import { k8sNamespace, kubectlGetJson } from '#platform/k8s/kubectl'
import { sessionIdFromJobName } from '#platform/k8s/pods'
import { containerExec } from '#platform/k8s/exec'
import {
  PROXY_APP_NAME,
  PROXY_AUTH_SECRET_NAME,
  RELAY_PORT,
} from '#features/cluster/proxy-constants'
import type { RelayFactory } from '#platform/container/port'
import { serverLog } from '#log'

/**
 * The server side of the stream relay (docs/stream-relay.md): every
 * steady-state byte between the server and a session pod — terminal PTYs,
 * the status watcher's tmux control stream, forwarded TCP, one-shot pod
 * commands — rides a plain TCP connection through the proxy's relay
 * listener into the pod's streamd, entirely off the apiserver. kubectl
 * exec survives only for session-create provisioning (the bounded setup
 * execs that run before streamd exists, incl. `bootStreamd`) and
 * non-session infra pods.
 *
 * Wire shape per stream: one relay auth line
 * `{token: <proxyAuthSecret>, sessionId}`, then one streamd handshake
 * line `{token: <per-session HMAC>, kind, ...params}`, then streamd's
 * `{ok}` reply line, then the payload. Both lines are pipelined in one
 * write; the relay is a dumb splice after its auth line.
 */

/** Dial + handshake deadline for a new stream. */
const DIAL_TIMEOUT_MS = 15_000
/** Reply-line cap (it is one small JSON object). */
const REPLY_MAX_BYTES = 16 * 1024

interface RelayAddr {
  host: string
  port: number
}

let cachedAddr: RelayAddr | null = null
let cachedSecret: string | null = null
let portForwardChild: ChildProcess | null = null

/** Drop the cached relay address so the next dial re-resolves it (an inner
 *  proxy pod replacement moves the target IP; a dead port-forward child
 *  gets respawned). */
export function invalidateRelayAddr(): void {
  cachedAddr = null
  portForwardChild?.kill()
  portForwardChild = null
}

/** Test-only: reset all module caches. */
export function _resetRelayCacheForTests(): void {
  invalidateRelayAddr()
  cachedSecret = null
}

/**
 * The default top-level relay path: ONE long-lived `kubectl port-forward`
 * to the proxy Deployment serves every stream of this server run (SPDY
 * multiplexes them; a new stream is a cheap stream-open, not an exec
 * round trip). This deliberately keeps the proxy↔host hop on the
 * apiserver: it costs a few Go userspace copies on a loopback-local hop,
 * and buys zero listening host ports, zero kind port mappings, and no
 * cluster-shape dependency — while the wins the relay exists for (no
 * kubectl child per stream, no per-connection exec setup, session-pod
 * bytes leaving via netstack networking instead of the gVisor exec
 * machinery) are all preserved. Works because the proxy is a runc pod
 * (CRI port-forward dials localhost in the pod netns, which a gVisor
 * pod's netstack would not answer — see ExecTunnel). Hosts with a direct
 * TCP route to the proxy (a server on the cluster node itself) can skip
 * the hop via YAAC_RELAY_ADDR.
 */
function startRelayPortForward(): Promise<RelayAddr> {
  return new Promise((resolve, reject) => {
    const child = spawn('kubectl', [
      'port-forward', '-n', k8sNamespace(), `deploy/${PROXY_APP_NAME}`, `0:${RELAY_PORT}`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    portForwardChild = child
    let out = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error('relay port-forward did not become ready within 15s'))
    }, 15_000)
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
      const m = /Forwarding from 127\.0\.0\.1:(\d+)/.exec(out)
      if (m && !settled) {
        settled = true
        clearTimeout(timer)
        resolve({ host: '127.0.0.1', port: Number(m[1]) })
      }
    })
    child.stderr?.on('data', () => { /* surfaced via exit/timeout */ })
    child.on('exit', () => {
      if (portForwardChild === child) portForwardChild = null
      cachedAddr = null
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error('relay port-forward exited during startup'))
      }
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
  })
}

/** Single-flight guard so concurrent dials share one resolution (and
 *  never race two port-forward children into existence). */
let resolveInflight: Promise<RelayAddr> | null = null

/**
 * Where this install's relay listens, cached per resolution:
 *  1. `YAAC_RELAY_ADDR` — explicit override (a host with a direct TCP
 *     route to the proxy pod).
 *  2. Nested: the inner proxy's pod IP (a host pod IP by syncer
 *     write-back), read from the vcluster apiserver. The dial is admitted
 *     by the existing all-ports synced-pod egress rule.
 *  3. Top-level: the local listener of a long-lived kubectl port-forward
 *     into the proxy (see startRelayPortForward).
 */
export async function resolveRelayAddr(): Promise<RelayAddr> {
  const override = env.relayAddr
  if (override) return override
  if (cachedAddr) return cachedAddr
  if (resolveInflight) return resolveInflight
  resolveInflight = (async () => {
    if (env.nested) {
      interface RawPods { items: Array<{ status?: { podIP?: string; phase?: string } }> }
      const list = await kubectlGetJson<RawPods>([
        'get', 'pods', '-n', k8sNamespace(), '-l', `app=${PROXY_APP_NAME}`,
      ])
      const ip = list?.items.find((p) => p.status?.phase === 'Running')?.status?.podIP
        ?? list?.items[0]?.status?.podIP
      if (!ip) throw new Error('stream relay: no inner proxy pod IP yet')
      cachedAddr = { host: ip, port: RELAY_PORT }
    } else {
      cachedAddr = await startRelayPortForward()
    }
    return cachedAddr
  })().finally(() => {
    resolveInflight = null
  })
  return resolveInflight
}

/**
 * The install's proxy auth secret — the relay bearer and the HMAC key for
 * per-session stream tokens. Read once per server run (it is generated
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
 * A session's streamd token: HMAC-SHA256(proxyAuthSecret, sessionId).
 * Derived (never stored), so it survives server restarts; session-create
 * injects it into the pod as YAAC_STREAM_TOKEN.
 */
export async function sessionStreamToken(sessionId: string): Promise<string> {
  const secret = await relaySecret()
  return crypto.createHmac('sha256', secret).update(sessionId).digest('hex')
}

/** Transport-level dial failure (relay unreachable, refused handshake,
 *  timeout) — never conclusive about the pod's state. */
export class RelayDialError extends Error {}

/**
 * Open one stream to a session's streamd: dial the relay, pipeline the
 * relay auth line + streamd handshake line, await streamd's `{ok}` reply.
 * Resolves with the connected socket, paused, with any bytes past the
 * reply line unshifted. Rejects with RelayDialError on any failure and
 * drops the cached relay address so the next dial re-resolves.
 */
export async function relayDial(
  sessionId: string,
  handshake: Record<string, unknown>,
  opts: { timeoutMs?: number } = {},
): Promise<net.Socket> {
  const timeoutMs = opts.timeoutMs ?? DIAL_TIMEOUT_MS
  const [addr, secret, token] = await Promise.all([
    resolveRelayAddr(),
    relaySecret(),
    sessionStreamToken(sessionId),
  ]).catch((err: unknown) => {
    throw new RelayDialError(`stream relay: ${err instanceof Error ? err.message : String(err)}`)
  })

  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect(addr.port, addr.host)
    let settled = false
    let gotReply = false
    let buf = Buffer.alloc(0)

    const fail = (reason: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      // Re-resolve the address only when the TRANSPORT looks dead (no
      // reply line ever arrived — a dead port-forward accepts and then
      // drops, a refused connect never answers). A stream that got a
      // reply and was refused proves the transport is fine; killing the
      // shared port-forward for it would drop every other live stream.
      if (!gotReply) invalidateRelayAddr()
      reject(new RelayDialError(`stream relay dial (${sessionId.slice(0, 8)}...): ${reason}`))
    }
    const timer = setTimeout(() => fail(`timeout after ${timeoutMs}ms`), timeoutMs)

    socket.on('error', (err: Error) => fail(err.message))
    socket.on('close', () => fail('connection closed during handshake'))
    socket.on('connect', () => {
      socket.write(
        JSON.stringify({ token: secret, sessionId }) + '\n'
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
      gotReply = true
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

// ── One-shot commands (the containerExec replacement for session pods) ──────

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
      reject(new RelayDialError(`stream read timeout after ${timeoutMs}ms`))
    }, timeoutMs)
    socket.on('data', (c: Buffer) => chunks.push(c))
    socket.on('error', (err: Error) => {
      clearTimeout(timer)
      reject(new RelayDialError(err.message))
    })
    socket.on('close', () => {
      clearTimeout(timer)
      resolve(Buffer.concat(chunks))
    })
    socket.resume()
  })
}

export interface RelayExecOptions {
  /** Overall deadline (dial + run). Default 30s. */
  timeout?: number
  /** Dial-failure retries (a clean nonzero exit is never retried — the
   *  command ran). Default 3. */
  maxAttempts?: number
}

/**
 * Run a shell command inside a session pod via its streamd — the drop-in
 * replacement for `containerExec` on session pods. `cmd` is a
 * shell-formatted command tail (executed as `sh -c <cmd>` in the pod —
 * one shell pass, like the host-shell pass `containerExec` gave it).
 * Resolves `{stdout, stderr}` on exit 0; throws RelayExecError on a
 * nonzero exit and RelayDialError when the pod was never reached.
 */
export async function sessionExec(
  jobName: string,
  cmd: string,
  opts: RelayExecOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const sessionId = sessionIdFromJobName(jobName)
  const timeoutMs = opts.timeout ?? 30_000
  const maxAttempts = opts.maxAttempts ?? 3
  let lastErr: Error = new RelayDialError('no attempts made')
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const started = Date.now()
    try {
      const socket = await relayDial(
        sessionId,
        { kind: 'exec', cmd: ['sh', '-c', cmd] },
        { timeoutMs },
      )
      const body = await readAll(socket, Math.max(1, timeoutMs - (Date.now() - started)))
      let result: { exitCode?: number; stdout?: string; stderr?: string }
      try {
        result = JSON.parse(body.toString('utf8')) as typeof result
      } catch {
        throw new RelayDialError('malformed exec result')
      }
      const { exitCode = 1, stdout = '', stderr = '' } = result
      if (exitCode === 0) return { stdout, stderr }
      throw new RelayExecError(
        `command exited ${exitCode} in ${jobName}: ${stderr.trim() || stdout.trim()}`,
        exitCode, stdout, stderr,
      )
    } catch (err) {
      lastErr = err as Error
      if (!(err instanceof RelayDialError) || attempt === maxAttempts) throw err
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

export function dialCtrlStream(sessionId: string, argv: string[]): StreamChild {
  const emitter = new EventEmitter()
  const dataCbs: Array<(chunk: Buffer | string) => void> = []
  const pending: string[] = []
  let sock: net.Socket | null = null
  let killed = false

  relayDial(sessionId, { kind: 'ctrl', cmd: argv }).then(
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
  sessionId: string,
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

  relayDial(sessionId, {
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

/**
 * RelayFactory over `tcp` streams — the per-connection port-forward
 * transport. Returns a child-shaped object whose stdin/stdout are
 * PassThroughs spliced onto the stream once the dial lands, so
 * `startPortForwarders`' wiring (pipe both ways, kill on close) is
 * unchanged.
 */
export function relayTcpFactory(sessionId: string): RelayFactory {
  return (containerPort) => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const emitter = new EventEmitter()
    let sock: net.Socket | null = null
    let killed = false

    relayDial(sessionId, { kind: 'tcp', port: containerPort }).then(
      (socket) => {
        if (killed) {
          socket.destroy()
          return
        }
        sock = socket
        stdin.pipe(socket)
        socket.pipe(stdout)
        socket.on('error', () => { /* 'close' follows */ })
        socket.on('close', () => emitter.emit('close'))
        socket.resume()
      },
      (err: Error) => {
        if (killed) return
        serverLog(`[server] port-forward relay dial failed: ${err.message}`)
        emitter.emit('close')
      },
    )

    return {
      stdin,
      stdout,
      kill: () => {
        killed = true
        sock?.destroy()
        stdin.destroy()
        stdout.destroy()
      },
      on: (event: 'close' | 'error', cb: (...args: unknown[]) => void) => {
        emitter.on(event, cb)
      },
    }
  }
}

// ── streamd lifecycle ──────────────────────────────────────────────────────

/**
 * Start (or restart) streamd in a session pod — the one steady-state
 * kubectl exec that remains, because it is what heals a crashed streamd
 * when no stream can reach the pod. Idempotent: a second daemon exits on
 * EADDRINUSE. Used by session-create's setup and the status watcher's
 * self-heal.
 */
export async function bootStreamd(jobName: string): Promise<void> {
  await containerExec(
    jobName,
    `sh -c 'setsid node /opt/yaac/streamd/main.js >>/tmp/streamd.log 2>&1 </dev/null &'`,
    { maxAttempts: 1, timeout: 15_000 },
  )
}

/** Test seam for waitForStreamd (the module's own exec/boot functions). */
export interface WaitForStreamdDeps {
  exec: typeof sessionExec
  boot: typeof bootStreamd
  sleepMs: (ms: number) => Promise<void>
}

/**
 * Gate on a session pod's streamd answering the relay — session-create's
 * "in-pod setup done" signal. The pod's postStart hook (yaac-session-init)
 * starts streamd last, so a successful relay exec proves the git config and
 * tmux server it configured are in place, and every setup command that
 * follows can ride the relay instead of kubectl exec.
 *
 * Dial failures are retried until the deadline: right after pod-Ready the
 * proxy may not have observed the pod IP yet, and streamd's node process
 * takes a beat to bind. Halfway through the budget, `bootStreamd` re-runs
 * the daemon via kubectl exec once — the same self-heal the status watcher
 * uses — so a streamd that failed to start in the hook still recovers.
 */
export async function waitForStreamd(
  jobName: string,
  opts: { timeoutMs?: number } = {},
  deps?: WaitForStreamdDeps,
): Promise<void> {
  const d = deps ?? {
    exec: sessionExec,
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
      if (Date.now() >= deadline) {
        throw new Error(
          `streamd in ${jobName} not reachable after ${timeoutMs}ms: ${err.message}`,
        )
      }
      if (!healed && Date.now() >= deadline - timeoutMs / 2) {
        healed = true
        await d.boot(jobName).catch(() => { /* dial loop keeps trying */ })
      }
      await d.sleepMs(300)
    }
  }
}
