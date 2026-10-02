import { WebSocket } from 'ws'
import { wsUrl } from '#api-core'
import type { ServerTarget } from '#server-api'
import type { ServerSnapshot } from '#types'

/**
 * A long-lived `/events` subscription for node clients: the desktop shell's
 * tray badge, notifications and port forwards, and `yaac forward`. The
 * target is re-resolved on every reconnect, so switching servers takes
 * effect on the next connection.
 */

/** The socket surface the monitor needs, so tests can script one. */
export interface EventsSocket {
  onMessage(cb: (data: string) => void): void
  /** Close and error both mean "this connection is over" to the monitor. */
  onClose(cb: () => void): void
  close(): void
}

export interface EventsMonitorDeps {
  /** Fresh target per connection attempt (resolveServerTarget). */
  resolveTarget(): Promise<ServerTarget>
  onSnapshot(snapshot: ServerSnapshot): void
  /** Defaults to a `ws` client. */
  openSocket?: (url: string) => EventsSocket
  /** Delay before reconnecting after a drop or failed resolve. */
  reconnectDelayMs?: number
}

/**
 * Parse a raw `/events` frame; return the snapshot payload, or null for
 * anything that isn't a `snapshot` event (or is malformed).
 */
function parseSnapshotMessage(raw: string): ServerSnapshot | null {
  try {
    const parsed = JSON.parse(raw) as { type?: unknown; data?: unknown }
    if (parsed.type === 'snapshot' && parsed.data !== null && typeof parsed.data === 'object') {
      return parsed.data as ServerSnapshot
    }
  } catch {
    // malformed frame — ignore
  }
  return null
}

function openWsSocket(url: string): EventsSocket {
  const socket = new WebSocket(url)
  return {
    onMessage: (cb) => socket.on('message', (data) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
      cb(buf.toString('utf8'))
    }),
    onClose: (cb) => {
      socket.on('close', cb)
      socket.on('error', cb)
    },
    close: () => socket.close(),
  }
}

export function startEventsMonitor(deps: EventsMonitorDeps): { stop: () => void } {
  const delay = deps.reconnectDelayMs ?? 1500
  const openSocket = deps.openSocket ?? openWsSocket
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
      // No server selected yet; keep retrying.
      scheduleReconnect()
      return
    }
    if (stopped) return
    let over = false // onClose can follow an error close; reconnect once
    const s = openSocket(wsUrl(target.baseUrl, '/api/events'))
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
