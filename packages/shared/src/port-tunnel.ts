import { STATUS_CODES } from 'node:http'
import net from 'node:net'
import { WebSocket } from 'ws'
import { wsUrl } from '#api-core'
import { parseWorkspaceHost } from '#workspace-hosts'

/**
 * The client half of a workspace port forward: a listener on the user's
 * machine that opens one WebSocket to the server's `/forward/attach` per
 * accepted connection (docs/port-forward-tunnel.md). The server cannot
 * bind the port itself, since it may be a pod or on another machine.
 *
 * Lives in `@yaac/shared` so the desktop app, which may import nothing
 * else, can run forwards. Connections are not multiplexed: each binary
 * message carries bytes for its one connection, and either end closing
 * ends the pair.
 */

/** Where the forwards go. */
export interface TunnelTarget {
  /** Server origin, no trailing slash — `ServerTarget.baseUrl`. */
  baseUrl: string
}

/** One port of one workspace, and where to offer it locally. */
export interface ForwardSpec {
  /** Workspace id or name, resolved server-side like any other route. */
  session: string
  containerPort: number
  hostPort: number
}

export interface ForwardHandle {
  /** The port actually bound (useful when `spec.hostPort` was 0). */
  readonly hostPort: number
  /** Stop listening and cut every open connection, so a stopped forward
   *  stops reaching the workspace at once rather than when its last
   *  keep-alive or websocket closes. */
  close(): void
}

/** Optional progress callbacks for a running forward. */
export interface ForwardEvents {
  onConnection?: () => void
  /** One connection failed (workspace gone, nothing listening, or the
   *  server refused). The forward keeps running. */
  onConnectionError?: (message: string) => void
}

/**
 * Connect one accepted TCP connection to one tunnel WebSocket. The socket
 * stays paused until the WebSocket opens so early bytes are not lost.
 */
function bridge(
  socket: net.Socket,
  target: TunnelTarget,
  spec: Pick<ForwardSpec, 'session' | 'containerPort'>,
  events: ForwardEvents,
): void {
  socket.pause()
  const ws = new WebSocket(wsUrl(target.baseUrl, '/api/forward/attach', {
    id: spec.session,
    port: spec.containerPort,
  }))

  let reported = false
  const fail = (message: string): void => {
    if (!reported) {
      reported = true
      events.onConnectionError?.(message)
    }
    socket.destroy()
    // `ws.close()` throws while CONNECTING; terminate always works.
    ws.terminate()
  }

  ws.on('open', () => {
    socket.on('data', (chunk: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk)
    })
    socket.resume()
  })
  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
    socket.write(Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer))
  })
  // Codes >= 4000 are the server's explanation of a failed dial.
  ws.on('close', (code: number, reason: Buffer) => {
    if (code >= 4000) fail(reason.toString('utf8') || `tunnel closed (${code})`)
    else socket.end()
  })
  ws.on('error', (err: Error) => fail(err.message))
  socket.on('error', () => { ws.terminate() })
  socket.on('close', () => { ws.terminate() })
}

/**
 * Listen on `port` and hand each accepted connection to `onSocket`. Rejects
 * if the port cannot be bound.
 */
function listen(
  port: number,
  bindHost: string,
  onSocket: (socket: net.Socket) => void,
): Promise<ForwardHandle> {
  return new Promise((resolve, reject) => {
    const open = new Set<net.Socket>()
    const server = net.createServer((socket) => {
      open.add(socket)
      socket.once('close', () => open.delete(socket))
      onSocket(socket)
    })
    server.once('error', (err: Error) => reject(err))
    server.listen(port, bindHost, () => {
      const addr = server.address()
      resolve({
        hostPort: typeof addr === 'object' && addr ? addr.port : port,
        close: () => {
          server.close()
          for (const socket of open) socket.destroy()
        },
      })
    })
  })
}

/**
 * Bind `spec.hostPort` and forward every connection to the workspace's
 * `spec.containerPort`. Rejects if the port cannot be bound.
 */
export function startForward(
  target: TunnelTarget,
  spec: ForwardSpec,
  opts: { bindHost?: string } & ForwardEvents = {},
): Promise<ForwardHandle> {
  const { bindHost = '127.0.0.1', ...events } = opts
  return listen(spec.hostPort, bindHost, (socket) => {
    events.onConnection?.()
    bridge(socket, target, spec, events)
  })
}

/**
 * Bind `port` and route each connection by the workspace hostname in its
 * first request's `Host` (docs/workspace-hostnames.md) into the tunnel to
 * the forward `resolve` finds for it, or answer 404 when it finds none.
 * The whole connection goes to that one port, so keep-alive and WebSocket
 * upgrades pass through as bytes.
 */
export function startHostRouter(
  target: TunnelTarget,
  port: number,
  resolve: (host: { port: number; idPrefix: string }) => Pick<ForwardSpec, 'session' | 'containerPort'> | undefined,
  opts: { bindHost?: string } & ForwardEvents = {},
): Promise<ForwardHandle> {
  const { bindHost = '127.0.0.1', ...events } = opts
  return listen(port, bindHost, (socket) => {
    void readRequestHead(socket).then((header) => {
      if (!header) return
      const host = header('host') ?? ''
      const name = parseWorkspaceHost(host)
      const spec = name ? resolve(name) : undefined
      if (!spec) {
        answerAndClose(socket, 404, `${host || 'this host'} names no port a workspace offers here`)
        return
      }
      events.onConnection?.()
      bridge(socket, target, spec, events)
    })
  })
}

/** The most a request head may take before it is handed on unread. */
const MAX_HEAD_BYTES = 16 * 1024
/** How long a connection may take to send its head; Node's own limit. */
const HEAD_TIMEOUT_MS = 60_000

/**
 * Read a new connection's first request head, then put its bytes back and
 * leave the socket paused, so it can be handed on as if unread. Resolves a
 * lookup of the head's header fields (lowercase names, first wins); one too
 * large to be a request head has none. A connection that closes or stalls
 * before its head is complete is destroyed and resolves null.
 */
export function readRequestHead(socket: net.Socket): Promise<((name: string) => string | undefined) | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    const finish = (head: string | null): void => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('end', onGone)
      socket.off('error', onGone)
      socket.pause()
      if (head === null) {
        socket.destroy()
        resolve(null)
        return
      }
      socket.unshift(Buffer.concat(chunks))
      const fields = new Map<string, string>()
      for (const line of head.split('\r\n').slice(1)) {
        const colon = line.indexOf(':')
        const name = line.slice(0, colon).trim().toLowerCase()
        if (colon > 0 && !fields.has(name)) fields.set(name, line.slice(colon + 1).trim())
      }
      resolve((name) => fields.get(name))
    }
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk)
      size += chunk.length
      const end = Buffer.concat(chunks).indexOf('\r\n\r\n')
      if (end >= 0) finish(Buffer.concat(chunks).subarray(0, end).toString('latin1'))
      else if (size > MAX_HEAD_BYTES) finish('')
    }
    const onGone = (): void => finish(null)
    const timer = setTimeout(onGone, HEAD_TIMEOUT_MS)
    socket.on('data', onData)
    socket.once('end', onGone)
    socket.once('error', onGone)
  })
}

/**
 * Answer a request with a plain-text status and close the connection. The
 * rest of the request is read and dropped, or the peer's end of the
 * connection would never be seen and it would stay half-open.
 */
export function answerAndClose(socket: net.Socket, status: number, text: string): void {
  const body = `${text}\n`
  socket.on('error', () => { /* the peer may already be gone */ })
  socket.resume()
  socket.end(
    `HTTP/1.1 ${String(status)} ${STATUS_CODES[status] ?? ''}\r\n`
    + 'content-type: text/plain; charset=utf-8\r\n'
    + `content-length: ${String(Buffer.byteLength(body))}\r\n`
    + 'connection: close\r\n\r\n'
    + body,
  )
}
