import { proxyClient } from './proxy-client'
import { notifyWorktreeListChanged } from '#notify'
import { serverLog } from '#log'

/**
 * The server's subscription to the egress proxy's change stream.
 *
 * Three things only the proxy process can see are inputs to the server's
 * work: a worktree's blocked-host set growing, a git credential being
 * rejected upstream, and an in-worktree `yaac-mama` landing in its queue.
 * The proxy cannot dial the server (it is an in-cluster pod; the server is
 * a host process with no in-cluster address, and nested it sits inside a
 * pod of the *outer* cluster), so the signal rides the control tunnel the
 * server already holds — one long-lived `GET /events`.
 *
 * The events carry no state, on purpose. `/data/blocked-hosts.json` and
 * `/data/git-auth-failures.json` remain the data plane — they are also how
 * a replaced proxy comes back knowing this state — and the spawn queue is
 * drained over its own claim protocol. So every event means only "look
 * again", and a reconnect re-fires all of them: a dropped stream can cost
 * latency, never a lost update.
 */

/** A change the reconciler owes a pass on, as this stream reports it. */
export const PROXY_CHANGE_SOURCES = ['mama-requests', 'proxy-reconnect'] as const
export type ProxyChangeSource = typeof PROXY_CHANGE_SOURCES[number]

/** First respawn delay after a stream death; doubles to the cap. */
const RESPAWN_BASE_MS = 250
/**
 * Cap on the respawn delay. Bounds the only window in which proxy-owned
 * state is staler than it was under the old 5s reconcile poll, so keep it
 * at that order.
 */
const RESPAWN_MAX_MS = 5_000
/**
 * Read-idle deadline. The proxy pings every 15s, so silence past this
 * means the tunnel is dead in a way TCP has not noticed (a wedged
 * apiserver, a killed exec relay).
 */
const IDLE_DEADLINE_MS = 45_000
/**
 * Deadline on the connect itself, which is a distinct hang from an idle
 * stream: the dial is the bare `fetch` (a stream cannot carry
 * `tunnelFetch`'s 15s timeout), and a relay that accepts the TCP
 * connection but never returns response headers would otherwise leave the
 * await suspended forever — no timer armed, nothing to abort it, and the
 * run loop never coming back round. Same 15s `tunnelFetch` uses, and the
 * same failure it exists for.
 */
const CONNECT_DEADLINE_MS = 15_000
/** Guard against a peer that never sends a newline. */
const MAX_LINE_BYTES = 64 * 1024

export interface ProxyEventStreamDeps {
  /** Injected for tests — replaces the real dial. */
  open?: (signal: AbortSignal) => Promise<Response>
  respawnDelayMs?: number
  maxRespawnDelayMs?: number
  idleDeadlineMs?: number
  connectDeadlineMs?: number
  /** Injected for tests — replaces the timer-based respawn wait. */
  sleep?: (ms: number) => Promise<void>
}

async function defaultOpen(signal: AbortSignal): Promise<Response> {
  // The proxy may not be deployed yet (a cold server, or a cluster that
  // comes up after us). Not an error worth logging every retry — just a
  // reason to wait.
  if (!(await proxyClient.attachIfRunning())) throw new ProxyNotReachable()
  return proxyClient.openEvents(signal)
}

class ProxyNotReachable extends Error {
  constructor() {
    super('egress proxy is not reachable')
  }
}

export class ProxyEventStream {
  private stopped = false
  private controller: AbortController | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private delayMs: number
  /** Suppresses repeat logging of an outage we have already reported. */
  private reportedDown = false

  private readonly open: (signal: AbortSignal) => Promise<Response>
  private readonly baseDelayMs: number
  private readonly maxDelayMs: number
  private readonly idleDeadlineMs: number
  private readonly connectDeadlineMs: number
  private readonly sleep: (ms: number) => Promise<void>

  /**
   * `onChange` marks the reconciler dirty. Snapshot-only events go straight
   * to `#notify` instead — the reconciler owes no work on a blocked host.
   */
  constructor(
    private readonly onChange: (source: ProxyChangeSource) => void,
    deps: ProxyEventStreamDeps = {},
  ) {
    this.open = deps.open ?? defaultOpen
    this.baseDelayMs = deps.respawnDelayMs ?? RESPAWN_BASE_MS
    this.maxDelayMs = deps.maxRespawnDelayMs ?? RESPAWN_MAX_MS
    this.idleDeadlineMs = deps.idleDeadlineMs ?? IDLE_DEADLINE_MS
    this.connectDeadlineMs = deps.connectDeadlineMs ?? CONNECT_DEADLINE_MS
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.delayMs = this.baseDelayMs
  }

  start(): void {
    if (this.stopped) return
    void this.run()
  }

  /** Drop the stream. The held-open request would otherwise keep the exec
   *  relay (and its kubectl child) alive past server shutdown. */
  stop(): void {
    this.stopped = true
    this.clearIdleTimer()
    this.controller?.abort()
    this.controller = null
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      await this.connectOnce()
      if (this.stopped) return
      await this.sleep(this.delayMs)
      this.delayMs = Math.min(this.delayMs * 2, this.maxDelayMs)
    }
  }

  /** One connect-and-consume cycle. */
  private async connectOnce(): Promise<void> {
    const controller = new AbortController()
    this.controller = controller
    try {
      // Bound the dial. `consume` re-arms with the idle deadline once the
      // stream is live; until then this is the only thing that can end a
      // connect that hangs without failing.
      this.armDeadline(controller, this.connectDeadlineMs, 'connect timed out')
      const res = await this.open(controller.signal)
      if (!res.ok) throw new Error(`status ${res.status}`)

      // Attached. Whatever changed while we were away is invisible to us,
      // so assume everything did: one catch-up per source, which costs a
      // snapshot rebuild and a reconcile pass and heals any gap.
      //
      // Note what does NOT happen here: the backoff is not reset. Attaching
      // is cheap to do wrong — a proxy that accepts and immediately closes
      // would hot-loop at the base delay forever — so the reset waits until
      // the stream actually delivers something (see `consume`). A healthy
      // stream pings, so it always does.
      if (this.reportedDown) {
        serverLog('[server] proxy events: stream reattached')
        this.reportedDown = false
      }
      notifyWorktreeListChanged()
      this.onChange('mama-requests')
      // A reattach is also the only edge that says "the proxy pod may have
      // been replaced" — which is exactly what the ssh-agent heal and the
      // ssh-key heal is waiting for.
      this.onChange('proxy-reconnect')

      await this.consume(res, controller)
    } catch (err) {
      if (!this.stopped && !this.reportedDown) {
        const reason = err instanceof ProxyNotReachable ? 'proxy not reachable' : String(err)
        serverLog(`[server] proxy events: stream down (${reason}); retrying`)
        this.reportedDown = true
      }
    } finally {
      this.clearIdleTimer()
      if (this.controller === controller) this.controller = null
      controller.abort()
    }
  }

  private async consume(res: Response, controller: AbortController): Promise<void> {
    const body = res.body
    if (!body) return
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    this.armDeadline(controller, this.idleDeadlineMs, 'no data past the idle deadline')
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done || this.stopped) return
        // The stream is carrying traffic, so the connection was real: this
        // is what earns the backoff reset.
        this.delayMs = this.baseDelayMs
        this.armDeadline(controller, this.idleDeadlineMs, 'no data past the idle deadline')
        buffer += decoder.decode(value, { stream: true })
        for (;;) {
          const nl = buffer.indexOf('\n')
          if (nl < 0) break
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          if (line) this.dispatch(line)
        }
        // A peer streaming without newlines is malformed, not a reason to
        // grow a buffer without bound.
        if (buffer.length > MAX_LINE_BYTES) buffer = ''
      }
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // Already released by the abort — nothing to do.
      }
    }
  }

  private dispatch(line: string): void {
    let type: unknown
    try {
      type = (JSON.parse(line) as { type?: unknown }).type
    } catch {
      return // not ours; ignore rather than tear the stream down
    }
    switch (type) {
      case 'blocked-hosts':
      case 'git-auth-failures':
        // Snapshot inputs the server re-reads off /data. No reconcile work.
        notifyWorktreeListChanged()
        return
      // `spawn` is what a proxy predating the yaac-mama command envelope
      // emits for the same edge; both mean "a worktree is waiting on an
      // answer" (docs/legacy-compat-shims.md).
      case 'mama':
      case 'spawn':
        this.onChange('mama-requests')
        return
      default:
        return // 'ping', or an event from a newer proxy we don't know
    }
  }

  /** Abort `controller` unless something re-arms within `ms`. One timer at
   *  a time — arming replaces whatever deadline was pending. */
  private armDeadline(controller: AbortController, ms: number, reason: string): void {
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => {
      serverLog(`[server] proxy events: ${reason} — reconnecting`)
      controller.abort()
    }, ms)
    this.idleTimer.unref()
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return
    clearTimeout(this.idleTimer)
    this.idleTimer = null
  }
}
