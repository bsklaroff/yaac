import net from 'node:net'
import { WebSocket } from 'ws'

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
 * The `/forward/attach` URL one connection opens. The WS scheme follows the
 * origin's (`https:` → `wss:`). Exported so tests can check that directly.
 */
export function tunnelUrl(target: TunnelTarget, spec: ForwardSpec): string {
  const url = new URL('/api/forward/attach', target.baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('id', spec.session)
  url.searchParams.set('port', String(spec.containerPort))
  return url.toString()
}

/**
 * Connect one accepted TCP connection to one tunnel WebSocket. The socket
 * stays paused until the WebSocket opens so early bytes are not lost.
 */
function bridge(
  socket: net.Socket,
  target: TunnelTarget,
  spec: ForwardSpec,
  events: ForwardEvents,
): void {
  socket.pause()
  const ws = new WebSocket(tunnelUrl(target, spec))

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
 * Bind `spec.hostPort` and forward every connection to the workspace's
 * `spec.containerPort`. Rejects if the port cannot be bound.
 */
export function startForward(
  target: TunnelTarget,
  spec: ForwardSpec,
  opts: { bindHost?: string } & ForwardEvents = {},
): Promise<ForwardHandle> {
  const { bindHost = '127.0.0.1', ...events } = opts
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      events.onConnection?.()
      bridge(socket, target, spec, events)
    })
    server.once('error', (err: Error) => reject(err))
    server.listen(spec.hostPort, bindHost, () => {
      const addr = server.address()
      resolve({
        hostPort: typeof addr === 'object' && addr ? addr.port : spec.hostPort,
        close: () => server.close(),
      })
    })
  })
}
