import type { ServerTarget } from '@yaac/shared/server-client'
import type { ServerSnapshot } from '@yaac/shared/types'
import { parseSnapshotMessage } from '#attention'

/**
 * Long-lived `/events` subscription for the tray/badge/notification signal.
 * The main process is a bearer client (the renderer's cookie never leaves the
 * window), so it opens the WS with the target's secret and re-resolves the
 * target on every (re)connect — the WS analog of createServerFetch's
 * BAD_BEARER re-resolve: a server restart rotates port+secret, and the next
 * reconnect picks the fresh lock up. Deps are injected so the loop
 * unit-tests without sockets or timers wired to a real server.
 */

/** The `/events` WS endpoint for a server origin (http→ws, https→wss). */
export function eventsWsUrl(baseUrl: string): string {
  const u = new URL(baseUrl)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.pathname = '/events'
  u.search = ''
  return u.toString()
}

/** The socket surface the monitor needs; main.ts adapts `ws` to it. */
export interface EventsSocket {
  onMessage(cb: (data: string) => void): void
  /** Close and error both mean "this connection is over" to the monitor. */
  onClose(cb: () => void): void
  close(): void
}

export interface EventsMonitorDeps {
  /** Fresh target per connection attempt (resolveServerTarget). */
  resolveTarget(): Promise<ServerTarget>
  openSocket(url: string, bearer: string): EventsSocket
  onSnapshot(snapshot: ServerSnapshot): void
  /** Delay before reconnecting after a drop or failed resolve. */
  reconnectDelayMs?: number
}

export function startEventsMonitor(deps: EventsMonitorDeps): { stop: () => void } {
  const delay = deps.reconnectDelayMs ?? 1500
  let stopped = false
  let socket: EventsSocket | null = null
  let timer: NodeJS.Timeout | null = null

  const scheduleReconnect = (): void => {
    if (stopped || timer) return
    timer = setTimeout(() => {
      timer = null
      void connect()
    }, delay)
  }

  const connect = async (): Promise<void> => {
    if (stopped) return
    let target: ServerTarget
    try {
      target = await deps.resolveTarget()
    } catch {
      // Server down (dead lock) — retry; the shell may be mid-starting it.
      scheduleReconnect()
      return
    }
    if (stopped) return
    let over = false // onClose can follow an error close; reconnect once
    const s = deps.openSocket(eventsWsUrl(target.baseUrl), target.secret)
    socket = s
    s.onMessage((data) => {
      const snapshot = parseSnapshotMessage(data)
      if (snapshot) deps.onSnapshot(snapshot)
    })
    s.onClose(() => {
      if (over) return
      over = true
      if (socket === s) socket = null
      scheduleReconnect()
    })
  }

  void connect()

  return {
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
      socket?.close()
      socket = null
    },
  }
}
