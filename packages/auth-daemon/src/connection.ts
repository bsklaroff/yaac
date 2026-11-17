import WebSocket from 'ws'
import { listenForRedirect, type RedirectListener } from '#oauth-callback'
import type { AgentOp, AgentReport } from '@yaac/shared/auth-agent-protocol'

/**
 * The auth daemon's one outbound WebSocket to the server's /api/agent/sign-in.
 * The server runs every sign-in; when one should come back to this machine
 * it sends `listen`, and the daemon says once it holds the loopback port,
 * then catches the vendor's redirect there and reports the code (or why it
 * could not).
 */

/** Reconnect backoff bounds. */
const BACKOFF_MIN_MS = 1000
const BACKOFF_MAX_MS = 10_000
/**
 * Ping interval. A half-open TCP connection (host slept, NAT dropped the
 * mapping) never emits 'close', so a ping left unanswered by the next tick
 * terminates the socket, which triggers a reconnect.
 */
const HEARTBEAT_MS = 15_000

function parseAgentOp(raw: string): AgentOp | null {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const m = obj as { op?: unknown; id?: unknown; url?: unknown }
  if (typeof m.id !== 'string') return null
  if (m.op === 'listen' && typeof m.url === 'string') return { op: 'listen', id: m.id, url: m.url }
  if (m.op === 'cancel') return { op: 'cancel', id: m.id }
  return null
}

export interface AuthAgentConnection {
  stop(): void
}

export function connectAuthAgent(opts: {
  baseUrl: string
  log: (line: string) => void
}): AuthAgentConnection {
  let stopped = false
  let ws: WebSocket | null = null
  let backoff = BACKOFF_MIN_MS
  let heartbeat: NodeJS.Timeout | null = null
  let reconnectTimer: NodeJS.Timeout | null = null
  const listeners = new Map<string, RedirectListener>()

  const report = (sock: WebSocket, msg: AgentReport): void => {
    if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(msg))
  }

  const stopListening = (id: string): void => {
    listeners.get(id)?.close()
    listeners.delete(id)
  }

  const listen = async (sock: WebSocket, id: string, url: string): Promise<void> => {
    stopListening(id)
    let listener: RedirectListener
    try {
      listener = await listenForRedirect(url)
    } catch (err) {
      report(sock, { op: 'listen-failed', id, error: err instanceof Error ? err.message : String(err) })
      return
    }
    // The socket went away while binding; its flows already moved on.
    if (sock !== ws) {
      listener.close()
      return
    }
    listeners.set(id, listener)
    report(sock, { op: 'listening', id })
    listener.result.then(
      ({ code, state }) => report(sock, { op: 'callback', id, code, state }),
      (err: unknown) => report(sock, { op: 'denied', id, error: err instanceof Error ? err.message : String(err) }),
    ).finally(() => {
      if (listeners.get(id) === listener) listeners.delete(id)
    })
  }

  const connect = (): void => {
    if (stopped) return
    const wsUrl = `${opts.baseUrl.replace(/^http/, 'ws')}/api/agent/sign-in`
    const sock = new WebSocket(wsUrl)
    ws = sock

    // Whether the last ping was answered. Starts true so the first tick
    // doesn't fault a fresh socket.
    let alive = true
    sock.on('pong', () => { alive = true })

    sock.on('open', () => {
      backoff = BACKOFF_MIN_MS
      opts.log(`connected to ${opts.baseUrl}`)
      heartbeat = setInterval(() => {
        if (!alive) {
          sock.terminate()
          return
        }
        alive = false
        try {
          sock.ping()
        } catch { /* socket tore down between tick and ping */ }
      }, HEARTBEAT_MS)
      heartbeat.unref?.()
    })

    sock.on('message', (data: Buffer | Buffer[]) => {
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : data.toString('utf8')
      const op = parseAgentOp(text)
      if (op?.op === 'listen') void listen(sock, op.id, op.url)
      else if (op?.op === 'cancel') stopListening(op.id)
    })

    sock.on('close', () => {
      opts.log('disconnected')
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = null
      // The server moves this socket's flows on without it.
      for (const id of [...listeners.keys()]) stopListening(id)
      if (ws === sock) ws = null
      if (stopped) return
      reconnectTimer = setTimeout(connect, backoff)
      reconnectTimer.unref?.()
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
    })
    sock.on('error', (err: Error) => {
      opts.log(`connection error: ${err.message}`)
      // 'close' follows 'error' on ws; reconnect is scheduled there.
    })
  }

  connect()

  return {
    stop: () => {
      stopped = true
      if (heartbeat) clearInterval(heartbeat)
      if (reconnectTimer) clearTimeout(reconnectTimer)
      for (const id of [...listeners.keys()]) stopListening(id)
      try {
        ws?.close(1000, 'auth daemon stopping')
      } catch { /* already gone */ }
    },
  }
}
