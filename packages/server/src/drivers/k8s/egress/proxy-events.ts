import { proxyClient } from './proxy-client'
import { serverLog } from '#log'

/**
 * The server's subscription to the egress proxy's change stream, one
 * long-lived `GET /events` (the proxy cannot dial the server). It signals
 * that an in-workspace `yaac-mama` request is queued and waiting for an
 * answer. Other proxy state (blocked hosts, git auth failures, captured
 * rotations) arrives through objects the `ClusterCache` watches.
 *
 * Events carry no payload; each means "drain the queue now". Every
 * (re)connect also triggers a drain, so a dropped stream costs latency but
 * never loses a request.
 */

/** The kinds of change this stream reports to the reconciler. */
export const PROXY_CHANGE_SOURCES = ['mama-requests'] as const
export type ProxyChangeSource = typeof PROXY_CHANGE_SOURCES[number]

/** First respawn delay after a stream death; doubles to the cap. */
const RESPAWN_BASE_MS = 250
/** Cap on the respawn delay, which bounds how late a queued request can
 *  be noticed while the stream is down. */
const RESPAWN_MAX_MS = 5_000
/** Read-idle deadline. The proxy pings every 15s, so silence past this
 *  means the connection is dead even if TCP hasn't noticed. */
const IDLE_DEADLINE_MS = 45_000
/** Deadline for the connect until response headers arrive. The dial has
 *  no fetch timeout of its own, so without this a peer that accepts but
 *  never responds would stall the run loop forever. */
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
  // The proxy may not be deployed yet; that is a reason to wait, not an
  // error to log.
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

  /** `onChange` marks the reconciler dirty. */
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

  /** Stop reconnecting and abort the held-open request. */
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

  /**
   * One connect-and-consume cycle. On attach it fires one catch-up drain
   * for anything queued while disconnected. The backoff resets only once
   * data arrives (in `consume`), so a proxy that accepts and immediately
   * closes can't cause a hot loop.
   */
  private async connectOnce(): Promise<void> {
    const controller = new AbortController()
    this.controller = controller
    try {
      this.armDeadline(controller, this.connectDeadlineMs, 'connect timed out')
      const res = await this.open(controller.signal)
      if (!res.ok) throw new Error(`status ${res.status}`)

      if (this.reportedDown) {
        serverLog('[server] proxy events: stream reattached')
        this.reportedDown = false
      }
      this.onChange('mama-requests')

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
      case 'mama':
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
