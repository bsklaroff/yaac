import WebSocket from 'ws'
import {
  cancelToolLogin,
  getToolLogin,
  sendToolLoginInput,
  startToolLogin,
} from '#tool-login'
import {
  cancelToolInstall,
  getToolInstall,
  startToolInstall,
} from '#tool-install'
import type { AgentKind, AgentOp } from '@yaac/shared/auth-agent-protocol'
import type { ToolInstallView, ToolLoginView } from '@yaac/shared/types'

/**
 * The auth daemon's side of the auth relay: one outbound WebSocket to the
 * server's /api/agent/auth. It runs start/input/cancel ops against the local
 * login and install managers, and samples their views every few hundred ms,
 * pushing each one that changed back to the server.
 */

/** How often local flow views are sampled for changes. */
const VIEW_SAMPLE_MS = 300
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
  const m = obj as { op?: unknown; id?: unknown; kind?: unknown; tool?: unknown; text?: unknown }
  if (typeof m.id !== 'string') return null
  if (m.op === 'start' && (m.kind === 'login' || m.kind === 'install')
    && (m.tool === 'claude' || m.tool === 'codex')) return m as AgentOp
  if (m.op === 'input' && typeof m.text === 'string') return m as AgentOp
  if (m.op === 'cancel' && (m.kind === 'login' || m.kind === 'install')) return m as AgentOp
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
  let sampler: NodeJS.Timeout | null = null
  let heartbeat: NodeJS.Timeout | null = null
  let reconnectTimer: NodeJS.Timeout | null = null

  // Flows this connection pushes, and the last view sent for each.
  const tracked = new Map<string, AgentKind>()
  const lastSent = new Map<string, string>()

  const readView = (id: string, kind: AgentKind): ToolLoginView | ToolInstallView | null => {
    try {
      return kind === 'login' ? getToolLogin(id) : getToolInstall(id)
    } catch {
      return null // cancelled or expired
    }
  }

  const pushViews = (): void => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    for (const [id, kind] of tracked) {
      const view = readView(id, kind)
      if (!view) {
        tracked.delete(id)
        lastSent.delete(id)
        continue
      }
      const serialized = JSON.stringify({ op: 'view', kind, view })
      if (lastSent.get(id) === serialized) continue
      lastSent.set(id, serialized)
      ws.send(serialized)
      // A finished flow's view never changes again.
      if (view.status !== 'running') {
        tracked.delete(id)
        lastSent.delete(id)
      }
    }
  }

  const handleOp = (op: AgentOp): void => {
    if (op.op === 'start') {
      tracked.set(op.id, op.kind)
      if (op.kind === 'login') {
        startToolLogin(op.tool, op.id).catch((err: unknown) =>
          opts.log(`login start failed: ${String(err)}`))
      } else {
        startToolInstall(op.tool, op.id)
      }
      return
    }
    if (op.op === 'input') {
      try {
        sendToolLoginInput(op.id, op.text)
      } catch (err) {
        // The flow ended after the server validated; the next view shows it.
        opts.log(`login input rejected: ${String(err)}`)
      }
      return
    }
    // cancel
    if (op.kind === 'login') cancelToolLogin(op.id)
    else cancelToolInstall(op.id)
    tracked.delete(op.id)
    lastSent.delete(op.id)
  }

  const connect = (): void => {
    if (stopped) return
    const wsUrl = `${opts.baseUrl.replace(/^http/, 'ws')}/api/agent/auth`
    const sock = new WebSocket(wsUrl)
    ws = sock

    // Whether the last ping was answered. Starts true so the first tick
    // doesn't fault a fresh socket.
    let alive = true
    sock.on('pong', () => { alive = true })

    sock.on('open', () => {
      backoff = BACKOFF_MIN_MS
      opts.log(`connected to ${opts.baseUrl}`)
      sampler = setInterval(pushViews, VIEW_SAMPLE_MS)
      sampler.unref?.()
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
      if (op) handleOp(op)
    })

    const scheduleReconnect = (): void => {
      if (sampler) clearInterval(sampler)
      sampler = null
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = null
      // Kill flows that can no longer report, so vendor CLIs don't linger.
      for (const [id, kind] of tracked) {
        if (kind === 'login') cancelToolLogin(id)
        else cancelToolInstall(id)
      }
      tracked.clear()
      lastSent.clear()
      if (stopped) return
      reconnectTimer = setTimeout(connect, backoff)
      reconnectTimer.unref?.()
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
    }

    sock.on('close', () => {
      opts.log('disconnected')
      scheduleReconnect()
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
      if (sampler) clearInterval(sampler)
      if (heartbeat) clearInterval(heartbeat)
      if (reconnectTimer) clearTimeout(reconnectTimer)
      try {
        ws?.close(1000, 'auth server stopping')
      } catch { /* already gone */ }
    },
  }
}
