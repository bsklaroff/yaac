import net from 'node:net'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { env } from '@yaac/shared/env'
import { FRAME_DATA, FRAME_EXIT, FRAME_RESIZE, FRAME_SIGNAL, FrameParser, encodeFrame } from '@yaac/shared/stream-frames'
import { k8sNamespace, kubectlGetJson } from './kubectl'
import { worktreeIdFromJobName } from './pods'
import { containerExec } from './exec'
import { invalidatePortForward, resolvePortForward } from './port-forward'
import {
  PROXY_APP_NAME,
  PROXY_AUTH_SECRET_NAME,
  RELAY_PORT,
} from './proxy-constants'
import type { RelayFactory } from '#lib/port'
import { serverLog } from '#log'

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

/** Key the shared port-forward registry files this install's relay child
 *  under (see port-forward.ts). */
const RELAY_FORWARD_KEY = 'stream-relay'

let cachedAddr: RelayAddr | null = null
let cachedSecret: string | null = null

/** Drop the cached relay address so the next dial re-resolves it (an inner
 *  proxy pod replacement moves the target IP; a dead port-forward child
 *  gets respawned). */
export function invalidateRelayAddr(): void {
  cachedAddr = null
  invalidatePortForward(RELAY_FORWARD_KEY)
}

/**
 * Drop a cached address that has nothing shared standing behind it — the
 * nested inner-proxy pod IP, whose re-resolution is one apiserver read and
 * disturbs no live stream. That makes it safe on evidence too weak to
 * justify `invalidateRelayAddr`, which is the point: a dial timeout is no
 * verdict on a transport, but an inner proxy pod that got replaced leaves
 * an IP that blackholes every dial, and nothing else mid-run would ever
 * look again. A live port-forward child is left strictly alone — the whole
 * reason timeouts stopped recycling is that respawning it drops every
 * stream riding it.
 *
 * That last part is now structural rather than a runtime check: `cachedAddr`
 * holds ONLY the nested pod IP, since the top-level path delegates its
 * address to the shared port-forward registry and never memoizes anything
 * here. So clearing it cannot reach a port-forward child — which is exactly
 * the guarantee the old `portForwardChild === null` test was making.
 */
function invalidateResolvedPodAddr(): void {
  cachedAddr = null
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
 * kubectl child per stream, no per-connection exec setup, worktree-pod
 * bytes leaving via netstack networking instead of the gVisor exec
 * machinery) are all preserved. Works because the proxy is a runc pod
 * (CRI port-forward dials localhost in the pod netns, which a gVisor
 * pod's netstack would not answer — see ExecTunnel). Hosts with a direct
 * TCP route to the proxy (a server on the cluster node itself) can skip
 * the hop via YAAC_RELAY_ADDR.
 */
function startRelayPortForward(): Promise<RelayAddr> {
  return resolvePortForward(RELAY_FORWARD_KEY, {
    namespace: k8sNamespace(),
    target: `deploy/${PROXY_APP_NAME}`,
    remotePort: RELAY_PORT,
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
  // Top-level: the shared port-forward registry owns both the cache and
  // the child's lifetime, so a child that dies is respawned on the next
  // dial rather than leaving a stale address memoized here.
  if (!env.nested) return startRelayPortForward()
  if (cachedAddr) return cachedAddr
  if (resolveInflight) return resolveInflight
  resolveInflight = (async () => {
    interface RawPods { items: Array<{ status?: { podIP?: string; phase?: string } }> }
    const list = await kubectlGetJson<RawPods>([
      'get', 'pods', '-n', k8sNamespace(), '-l', `app=${PROXY_APP_NAME}`,
    ])
    const ip = list?.items.find((p) => p.status?.phase === 'Running')?.status?.podIP
      ?? list?.items[0]?.status?.podIP
    if (!ip) throw new Error('stream relay: no inner proxy pod IP yet')
    cachedAddr = { host: ip, port: RELAY_PORT }
    return cachedAddr
  })().finally(() => {
    resolveInflight = null
  })
  return resolveInflight
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
 * reply line unshifted. Rejects with RelayDialError on any failure and
 * drops the cached relay address so the next dial re-resolves.
 */
export async function relayDial(
  worktreeId: string,
  handshake: Record<string, unknown>,
  opts: { timeoutMs?: number } = {},
): Promise<net.Socket> {
  const timeoutMs = opts.timeoutMs ?? DIAL_TIMEOUT_MS
  const [addr, secret, token] = await Promise.all([
    resolveRelayAddr(),
    relaySecret(),
    podStreamToken(worktreeId),
  ]).catch((err: unknown) => {
    throw new RelayDialError(`stream relay: ${err instanceof Error ? err.message : String(err)}`)
  })

  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect(addr.port, addr.host)
    let settled = false
    // Anything at all coming back, not just a whole line: a peer that spoke
    // is a peer that is there, which is what the evidence rule below turns
    // on. (An oversized reply is protocol corruption on a live transport.)
    let sawReplyBytes = false
    let buf = Buffer.alloc(0)

    /**
     * `transportDead` decides whether this one stream's failure recycles
     * the SHARED transport: `invalidateRelayAddr` kills the single
     * `kubectl port-forward` that every other stream rides, so every
     * terminal, status stream and forwarded port on the install dies with
     * it. Only two signals qualify, both immediate and unambiguous — a
     * connect error (nothing listening; the forward is gone) and a close
     * before any reply byte (a dead forward accepts, then drops). A
     * refusal, which arrives as a reply, proves the transport is fine.
     *
     * A TIMEOUT is deliberately none of the above. Waiting is what a
     * slow-but-live relay looks like: a host busy building images, an
     * apiserver list behind a pod-index miss, a pod whose ingress policy
     * is still dropping the proxy's SYNs. Recycling on it made one
     * stream's patience the whole install's problem — every terminal in
     * every worktree dropping and reconnecting together.
     */
    const fail = (reason: string, transportDead = !sawReplyBytes): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (transportDead) invalidateRelayAddr()
      reject(new RelayDialError(`stream relay dial (${worktreeId.slice(0, 8)}...): ${reason}`))
    }
    const timer = setTimeout(() => {
      // Too weak to condemn the shared transport, strong enough to re-read
      // an address that costs nothing to re-read (see the function).
      invalidateResolvedPodAddr()
      fail(`timeout after ${timeoutMs}ms`, false)
    }, timeoutMs)

    socket.on('error', (err: Error) => fail(err.message))
    socket.on('close', () => fail('connection closed during handshake'))
    socket.on('connect', () => {
      socket.write(
        // Both names, because this is the ONE proxy path with no currency
        // gate in front of it: relay dials never go through ProxyClient, and
        // the boot path attaches to whatever proxy is deployed without
        // checking its image. A server restarted onto new code therefore
        // talks to the OLD proxy until the first worktree create redeploys
        // it, and that proxy reads only `sessionId`.
        JSON.stringify({ token: secret, worktreeId, sessionId: worktreeId }) + '\n'
        + JSON.stringify({ token, ...handshake }) + '\n',
      )
    })
    const onData = (chunk: Buffer): void => {
      sawReplyBytes = true
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
      let result: { exitCode?: number; stdout?: string; stderr?: string }
      try {
        result = JSON.parse(body.toString('utf8')) as typeof result
      } catch {
        // Dispatched: streamd answered the handshake, so whatever came
        // back (truncated, empty, garbage) followed a command that ran.
        throw new RelayDialError('malformed exec result', true)
      }
      const { exitCode = 1, stdout = '', stderr = '' } = result
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

/**
 * RelayFactory over `tcp` streams — the per-connection port-forward
 * transport. Returns a child-shaped object whose stdin/stdout are
 * PassThroughs spliced onto the stream once the dial lands, so
 * `startPortForwarders`' wiring (pipe both ways, kill on close) is
 * unchanged.
 */
export function relayTcpFactory(worktreeId: string): RelayFactory {
  return (containerPort) => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const emitter = new EventEmitter()
    let sock: net.Socket | null = null
    let killed = false

    relayDial(worktreeId, { kind: 'tcp', port: containerPort }).then(
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
