import net from 'node:net'
import { WebSocket } from 'ws'

/**
 * The client half of a workspace port forward: a listener on the user's
 * machine, and one WebSocket to the server per connection it accepts.
 *
 * The listener lives here rather than in the server because the server has
 * nowhere to put it. Under `k8s` it is a pod, so a port it bound would be
 * on the pod's loopback; under `containerless` the workspace binds the
 * port itself and there is nothing to forward. What the server does hold
 * is the mapping (`forwardedPorts` on the worktree list) and the near end
 * of each connection (`/forward/attach`) — so a client that binds what the
 * mapping says makes the webapp's `127.0.0.1:<port>` links true for as
 * long as it runs.
 *
 * WS + `net` only, which is what lets this sit in `@yaac/shared`: the
 * desktop app is a resident forwarder and `@yaac/shared` is the only
 * package it may import.
 *
 * One WebSocket per accepted TCP connection — the kubectl shape. Nothing
 * is multiplexed, so nothing has to be framed: every binary message is
 * bytes for that one connection, in order, and either end closing ends the
 * pair. A chatty client pays one WS handshake per connection, which is the
 * trade this takes on purpose (multiplexing is a follow-up, wanted only if
 * that cost ever becomes visible).
 */

/** Where the forwards go, and what authenticates them. */
export interface TunnelTarget {
  /** Server origin, no trailing slash — `ServerTarget.baseUrl`. */
  baseUrl: string
  /** Bearer, exactly as the HTTP client sends it. */
  secret: string
}

/** One port of one workspace, and where to offer it locally. */
export interface ForwardSpec {
  /** Workspace id or name, resolved server-side like any other route. */
  session: string
  containerPort: number
  hostPort: number
}

export interface ForwardHandle {
  /** The port actually bound, which is `spec.hostPort` — restated so a
   *  caller that asked for 0 has an answer. */
  readonly hostPort: number
  close(): void
}

/** What a running forward reports. Everything here is best-effort colour
 *  for a CLI or a tray: nothing about the forward depends on it. */
export interface ForwardEvents {
  onConnection?: () => void
  /** One connection failed — the workspace is gone, nothing is listening
   *  on the container port, or the server refused. Never fatal to the
   *  forward itself: the next connection tries again. */
  onConnectionError?: (message: string) => void
}

/**
 * The `/forward/attach` URL one connection opens.
 *
 * Exported because the scheme rule is the whole of what it decides and the
 * only way to observe it is to look: the WS scheme has to follow the
 * origin's, or a forward against an `https://` server makes its upgrade in
 * the clear against a TLS listener. Asserting that on a live connection
 * would mean asserting on a connection ERROR, whose text is the ambient
 * network's to write — which is how a unit test starts failing inside a
 * sandbox whose proxy answers for every name.
 */
export function tunnelUrl(target: TunnelTarget, spec: ForwardSpec): string {
  const url = new URL('/forward/attach', target.baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('id', spec.session)
  url.searchParams.set('port', String(spec.containerPort))
  return url.toString()
}

/**
 * Splice one accepted TCP connection to one tunnel WebSocket.
 *
 * The socket is paused until the WebSocket opens, so the client's first
 * bytes — which for HTTP is the entire request — wait for the tunnel
 * instead of being written into a socket nothing is reading yet.
 */
function bridge(
  socket: net.Socket,
  target: TunnelTarget,
  spec: ForwardSpec,
  events: ForwardEvents,
): void {
  socket.pause()
  const ws = new WebSocket(tunnelUrl(target, spec), {
    headers: { authorization: `Bearer ${target.secret}` },
  })

  let reported = false
  const fail = (message: string): void => {
    if (!reported) {
      reported = true
      events.onConnectionError?.(message)
    }
    socket.destroy()
    // 1000 while CONNECTING throws in `ws`; terminate is unconditional and
    // this connection is over either way.
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
  // A close code the server chose is the only diagnosis a client gets — the
  // dial failed inside the cluster, where this process cannot look.
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
 * `spec.containerPort`.
 *
 * Rejects when the port cannot be bound — the one failure a forward cannot
 * work around, and the one the server could never have reported, since the
 * machine that binds is this one.
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
