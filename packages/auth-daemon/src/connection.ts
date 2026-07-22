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
 * The agent half of the auth relay: one outbound WebSocket to the main
 * server's /agent/auth, executing start/input/cancel ops against the
 * local login/install managers and pushing view snapshots back whenever
 * they change. Views are sampled from the local in-process registries
 * (cheap) so changes reach the server within one tick — the wire itself
 * is pure push.
 */

/** How often local flow views are sampled for changes. */
const VIEW_SAMPLE_MS = 300
/** Reconnect backoff bounds. */
const BACKOFF_MIN_MS = 1000
const BACKOFF_MAX_MS = 10_000
/**
 * Heartbeat: ping the server on this cadence and expect a pong before the
 * next tick. A half-open TCP connection (server host slept, NAT dropped the
 * mapping, network partition) delivers no 'close', so without this the push
 * socket would sit dead — silently swallowing sends and never reconnecting.
 * A missed pong terminates the socket, which fires 'close' → reconnect.
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
  secret: string
  log: (line: string) => void
}): AuthAgentConnection {
  let stopped = false
  let ws: WebSocket | null = null
  let backoff = BACKOFF_MIN_MS
  let sampler: NodeJS.Timeout | null = null
  let heartbeat: NodeJS.Timeout | null = null
  let reconnectTimer: NodeJS.Timeout | null = null

  // id → kind for flows this connection is responsible for pushing, and
  // the last serialized view sent so unchanged samples stay quiet.
  const tracked = new Map<string, AgentKind>()
  const lastSent = new Map<string, string>()

  const readView = (id: string, kind: AgentKind): ToolLoginView | ToolInstallView | null => {
    try {
      return kind === 'login' ? getToolLogin(id) : getToolInstall(id)
    } catch {
      return null // cancelled or lingered out — stop tracking
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
      // One final push carries the terminal state; nothing changes after.
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
        // The server validated before sending; a residual failure (flow
        // ended between hops) just surfaces via the next view push.
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
    const wsUrl = `${opts.baseUrl.replace(/^http/, 'ws')}/agent/auth`
    const sock = new WebSocket(wsUrl, {
      headers: { authorization: `Bearer ${opts.secret}` },
    })
    ws = sock

    // Flips true on every pong; the next heartbeat tick reads it to decide
    // whether the last ping was answered. Seeded true so the first tick,
    // one interval after 'open', doesn't fault a freshly-opened socket.
    let alive = true
    sock.on('pong', () => { alive = true })

    sock.on('open', () => {
      backoff = BACKOFF_MIN_MS
      opts.log(`connected to ${opts.baseUrl}`)
      sampler = setInterval(pushViews, VIEW_SAMPLE_MS)
      sampler.unref?.()
      heartbeat = setInterval(() => {
        if (!alive) {
          // Previous ping went unanswered — the peer is gone. terminate()
          // skips the close handshake and emits 'close' at once → reconnect.
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
      // Flows can't reach the server anymore — kill them so vendor CLIs
      // don't linger headless (the server marks its views failed too).
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
