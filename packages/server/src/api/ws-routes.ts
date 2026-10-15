import { upgradeWebSocket } from '@hono/node-server'
import type { Context, Hono, MiddlewareHandler } from 'hono'
import type { IdentityEnv } from '#api/http/web-auth'
import type { EventHub, WsLike } from '#api/events'
import { authorizeProject } from '#domain/access'
import { authAgentHub } from '#domain/auth'
import { recordOrigin, resolveWorkspaceContainer } from '#domain/workspaces'
import { findWorkspaceRow } from '#db'
import { attachPty, type SocketLike, TUNNEL_DIAL_FAILED, attachPortTunnel } from '#runtime/terminals'
import { attachAcp } from '#runtime/agents'
import { errorText, serverLog } from '#lib/log'
import { agentSessionIdSchema } from '@yaac/shared/types'
import { ServerError } from '@yaac/shared/errors'

/**
 * The server's WebSocket routes, under `/api` like the HTTP ones. They are
 * registered on the app `buildApp` returns rather than inside it, so its
 * type stays the plain Hono app the CLI's RPC client infers from.
 */

/**
 * The subset of the `ws` WebSocket (WSContext.raw) we use. `ws` is a
 * transitive dependency, so its types are not importable here.
 */
interface RawWebSocket {
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
  ping(): void
  terminate(): void
  readonly readyState: number
  readonly bufferedAmount: number
  on(event: 'message', cb: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void): void
  on(event: 'close', cb: () => void): void
  on(event: 'pong', cb: () => void): void
}

/** `WebSocket.OPEN` (the `ws` class constant is not importable here). */
const WS_OPEN = 1

/**
 * Heartbeat interval for the auth-agent socket. We ping the daemon and drop
 * the socket if a ping goes unanswered, so a dead daemon (host asleep,
 * network down) shows as disconnected instead of hanging sign-in ops.
 */
const AGENT_HEARTBEAT_MS = 15_000

/** The raw socket behind a Hono WebSocket context, which @hono/node-server
 *  always sets. */
function rawOf(ws: { raw?: unknown }): RawWebSocket {
  return ws.raw as RawWebSocket
}

/** A binary-capable socket for the PTY, forward and ACP bridges. */
function socketOf(ws: { raw?: unknown }): SocketLike {
  const raw = rawOf(ws)
  return {
    send: (data) => raw.send(data),
    close: (code, reason) => raw.close(code, reason),
    onMessage: (cb) => raw.on('message', (data, isBinary) =>
      cb(Array.isArray(data) ? Buffer.concat(data) : data, isBinary)),
    onClose: (cb) => raw.on('close', () => cb()),
    bufferedAmount: () => raw.bufferedAmount,
  }
}

type AttachTarget = Awaited<ReturnType<typeof resolveWorkspaceContainer>>

/**
 * An attach: a WebSocket into one running workspace, which grants execution
 * in it or a tunnel into it, so only its owner may open one.
 *
 * The id is exact, so a missing one is refused before any lookup, and the
 * conversation id (`session`) is validated because it is joined into a path
 * downstream. Ownership is checked against the workspace's row before the
 * upgrade, so a refusal is a 403, and again against the unit the id
 * resolves to once the socket opens, so an id with no row at upgrade time
 * is not let through. `setup` reads the request and says what to do with
 * the socket: `open` it onto the resolved workspace, or `refuse` it.
 */
function attachRoute(
  app: Hono<IdentityEnv>,
  path: string,
  opts: { session?: boolean },
  setup: (c: Context<IdentityEnv>) => {
    open: (target: AttachTarget, socket: SocketLike) => void
    refuse: (socket: SocketLike, err: unknown) => void
  },
): void {
  const checkQuery: MiddlewareHandler<IdentityEnv> = async (c, next) => {
    const id = c.req.query('id')
    if (!id) throw new ServerError('VALIDATION', 'a workspace id is required')
    if (opts.session && !agentSessionIdSchema.safeParse(c.req.query('session')).success) {
      throw new ServerError('VALIDATION', 'a valid conversation id is required')
    }
    const row = await findWorkspaceRow(id)
    if (row) await authorizeProject(c.get('principal'), row.projectId)
    await next()
  }
  app.get(path, checkQuery, upgradeWebSocket((c) => {
    const ctx = c as Context<IdentityEnv>
    const principal = ctx.get('principal')
    const id = c.req.query('id') ?? ''
    const { open, refuse } = setup(ctx)
    return {
      onOpen: (_evt, ws) => {
        const socket = socketOf(ws)
        void resolveWorkspaceContainer(id, { requireRunning: true, exact: true, owner: principal })
          .then((target) => open(target, socket), (err: unknown) => refuse(socket, err))
      },
    }
  }))
}

/** Send JSON frames to a socket that may already be gone. */
function trySend(socket: SocketLike, ...frames: object[]): void {
  try {
    for (const f of frames) socket.send(JSON.stringify(f))
  } catch { /* socket already gone */ }
}

export function registerWebSocketRoutes(app: Hono<IdentityEnv>, hub: EventHub): void {
  // The /events snapshot stream. Sends go through the raw `ws` socket:
  // WSContext.send passes `compress: undefined`, which overrides ws's
  // `compress: true` default and would leave snapshots uncompressed.
  app.get('/api/events', upgradeWebSocket(() => {
    let conn: WsLike | null = null
    return {
      onOpen: (_evt, ws) => {
        const raw = rawOf(ws)
        // `ws` ignores sends on a closed socket, so removal relies on
        // onClose/onError; the guard just skips sends while closing.
        conn = {
          send: (data: string) => { if (raw.readyState === WS_OPEN) raw.send(data) },
        }
        hub.add(conn)
        void hub.sendSnapshotTo(conn).catch(
          (err: unknown) => serverLog(`[server] events: initial snapshot failed: ${errorText(err)}`),
        )
      },
      onClose: () => { if (conn) hub.remove(conn) },
      onError: () => { if (conn) hub.remove(conn) },
    }
  }))

  // Auth-daemon relay: the login broker on each user's machine keeps one
  // outbound socket here, as that user; their sign-in routes forward ops
  // over it.
  app.get('/api/agent/auth', upgradeWebSocket((c) => {
    const owner = (c as Context<IdentityEnv>).get('principal').userId
    return {
      onOpen: (_evt, ws) => {
        const raw = rawOf(ws)
        const sock = {
          send: (data: string) => raw.send(data),
          close: (code?: number, reason?: string) => raw.close(code, reason),
        }
        authAgentHub.setSocket(owner, sock)
        raw.on('message', (data) => {
          const text = Array.isArray(data)
            ? Buffer.concat(data).toString('utf8')
            : Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8')
          authAgentHub.ingest(owner, text)
        })
        // Terminate if the previous ping got no pong. Starts true so a new
        // socket survives the first tick; terminate() leads to
        // handleDisconnect.
        let alive = true
        raw.on('pong', () => { alive = true })
        const heartbeat = setInterval(() => {
          if (!alive) {
            raw.terminate()
            return
          }
          alive = false
          try {
            raw.ping()
          } catch { /* socket tore down between tick and ping */ }
        }, AGENT_HEARTBEAT_MS)
        heartbeat.unref?.()
        raw.on('close', () => {
          clearInterval(heartbeat)
          authAgentHub.handleDisconnect(owner, sock)
        })
      },
    }
  }))

  // PTY bridge: one terminal per connection, attached to the workspace's
  // tmux. Not under /workspace/ to avoid colliding with GET /workspace/:id.
  // attachPty validates the query and spawns the PTY at the browser's size,
  // so tmux and the client grid match from the first frame.
  attachRoute(app, '/api/pty/attach', {}, (c) => {
    const id = c.req.query('id') ?? ''
    const query = { target: c.req.query('target'), cols: c.req.query('cols'), rows: c.req.query('rows') }
    return {
      open: ({ jobName }, socket) => {
        attachPty(jobName, socket, query)
        serverLog(`[server] pty attach: session=${id} job=${jobName}`)
      },
      refuse: (socket) => {
        trySend(socket, { type: 'error', message: 'session not found or not running' })
        socket.close(1011, 'resolve failed')
      },
    }
  })

  // Port-forward tunnel: one WebSocket per forwarded TCP connection. The
  // server binds no host port on either driver; `yaac forward` or the
  // desktop app listens on the user's machine and opens one of these per
  // connection (docs/port-forward-tunnel.md).
  attachRoute(app, '/api/forward/attach', {}, (c) => {
    const id = c.req.query('id') ?? ''
    const port = Number(c.req.query('port'))
    return {
      open: ({ workspaceId }, socket) => {
        if (!Number.isInteger(port) || port < 1 || port > 65535) socket.close(TUNNEL_DIAL_FAILED, 'bad port')
        else attachPortTunnel(workspaceId, port, socket)
      },
      refuse: (socket, err) => {
        serverLog(`[server] forward tunnel to ${id.slice(0, 8)}:${String(port)} refused: `
          + (err instanceof Error ? err.message : String(err)))
        socket.close(TUNNEL_DIAL_FAILED, 'session not found or not running')
      },
    }
  })

  // ACP bridge: one chat pane per connection, attached to the live
  // `AcpConversation` held by the status watcher's driver. Frames are JSON
  // events.
  attachRoute(app, '/api/acp/attach', { session: true }, (c) => {
    const id = c.req.query('id') ?? ''
    const agentSessionId = c.req.query('session') ?? ''
    return {
      open: ({ projectId }, socket) => {
        attachAcp(projectId, id, agentSessionId, socket, (life) => recordOrigin(projectId, id, agentSessionId, life))
        serverLog(`[server] acp attach: session=${id} conversation=${agentSessionId}`)
      },
      refuse: (socket) => {
        const message = 'session not found or not running'
        trySend(socket, { type: 'health', connected: false }, { type: 'error', message })
        socket.close(1011, message)
      },
    }
  })
}
