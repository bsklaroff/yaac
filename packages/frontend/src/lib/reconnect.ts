import { wsUrl } from '@yaac/shared/api-core'

/**
 * The SPA's WebSockets to the server's streams: `/events` (useEvents), an
 * ACP conversation (useAcpStream) and a terminal's `/pty/attach`
 * (WorkspaceTerminal). Each one reconnects through `reconnectingSocket`,
 * with exponential backoff: the delay doubles on each failure up to the
 * maximum.
 */
export const INITIAL_RECONNECT_DELAY_MS = 500
export const MAX_RECONNECT_DELAY_MS = 10_000

/**
 * How long a terminal must stay disconnected before WorkspaceTerminal shows
 * a notice. Most drops heal within a second (the terminal re-attaches and
 * tmux repaints), so this must outlast the first reconnect attempt (the
 * initial delay plus an attach) to avoid announcing them.
 */
export const DISCONNECT_NOTICE_DELAY_MS = 1_500

/** Next backoff delay: double the current one, capped at the ceiling. */
export function nextReconnectDelay(current: number): number {
  return Math.min(current * 2, MAX_RECONNECT_DELAY_MS)
}

export interface ReconnectingSocket {
  /** Send on the current socket. False when none is open, so the caller can
   *  keep what it meant to send. */
  send: (data: Parameters<WebSocket['send']>[0]) => boolean
  /** Close for good: no further callbacks or reconnects. */
  close: () => void
}

/**
 * Keep a WebSocket to `path()` (on the page's origin) open until `close()`.
 * `path` is read on every attempt, so it can carry current state.
 *
 * After a drop it reconnects with backoff, and at once when the tab is shown
 * again or the network returns, since a suspended laptop drops its sockets
 * silently. The backoff resets only when `message` returns true for a frame
 * that shows the attach is healthy, so a server that accepts, reports a
 * problem and closes still backs off. Callbacks come only from the current
 * socket; `close` reports whether the dropped socket had opened.
 */
export function reconnectingSocket(path: () => string, on: {
  open?: () => void
  /** Returns true when the frame shows a healthy attach. */
  message: (data: unknown) => boolean
  close?: (opened: boolean) => void
}): ReconnectingSocket {
  let sock: WebSocket | null = null
  let delay = INITIAL_RECONNECT_DELAY_MS
  let timer: ReturnType<typeof setTimeout> | undefined

  const connect = (): void => {
    const s = new WebSocket(wsUrl(window.location.origin, path()))
    s.binaryType = 'arraybuffer'
    sock = s
    let opened = false
    s.onopen = () => {
      opened = true
      on.open?.()
    }
    s.onmessage = (e: MessageEvent) => {
      if (on.message(e.data)) delay = INITIAL_RECONNECT_DELAY_MS
    }
    s.onerror = () => s.close()
    s.onclose = () => {
      if (s !== sock) return
      sock = null
      on.close?.(opened)
      timer = setTimeout(connect, delay)
      delay = nextReconnectDelay(delay)
    }
  }

  const wake = (): void => {
    if (sock !== null || document.visibilityState === 'hidden') return
    clearTimeout(timer)
    delay = INITIAL_RECONNECT_DELAY_MS
    connect()
  }
  document.addEventListener('visibilitychange', wake)
  window.addEventListener('online', wake)
  connect()

  return {
    send: (data) => {
      if (sock?.readyState !== WebSocket.OPEN) return false
      sock.send(data)
      return true
    },
    close: () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('online', wake)
      const s = sock
      sock = null
      if (!s) return
      s.onmessage = null
      s.onclose = null
      // Still connecting: close again once open, so the server tears down
      // what it set up for the attach (a terminal's PTY).
      s.onopen = s.readyState === WebSocket.CONNECTING ? () => s.close() : null
      s.close()
    },
  }
}
