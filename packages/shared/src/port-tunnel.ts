import { lookup } from 'node:dns/promises'
import { STATUS_CODES } from 'node:http'
import net from 'node:net'
import os from 'node:os'
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
  /**
   * A public site release's port, bound on loopback alone
   * (`createForwardSet`): whatever reaches the listener reaches the port as
   * its owner, and an admin port checks no one else (docs/public-sites.md
   * "Admin port").
   */
  loopbackOnly?: true
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

/** Where a tunnelled connection goes: a server, and one workspace port. */
export interface TunnelRoute {
  target: TunnelTarget
  spec: Pick<ForwardSpec, 'session' | 'containerPort'>
}

/** SOCKS5 reply to a request it will not serve: "not allowed by ruleset". */
const SOCKS_REFUSED = 0x02

/**
 * Bind a SOCKS5 proxy on a free loopback port, for one desktop preview
 * pane's session, which sends it every request (docs/port-forward-tunnel.md
 * "The desktop preview pane"). A CONNECT to a loopback name at some port is
 * tunnelled to the route `resolve` finds for that port, and refused when it
 * finds none. Any other host is dialed directly, unless it resolves to this
 * machine, so no name or address reaches the user's machine around the
 * tunnel. Chromium sends no SOCKS credentials, so which listener a
 * connection reached is all that says whose it is.
 */
export function startSocksTunnel(
  resolve: (port: number) => Promise<TunnelRoute | undefined>,
  opts: ForwardEvents = {},
): Promise<ForwardHandle> {
  return listen(0, '127.0.0.1', (socket) => {
    // Kept for the connection's life: the client may reset while its route
    // or dial is still pending.
    socket.on('error', () => { /* the close that follows ends the pair */ })
    void readSocksConnect(socket).then(async (request) => {
      if (!request) return
      if (isLoopbackName(request.host)) {
        const route = await withinHeadTimeout(resolve(request.port))
        if (socket.destroyed) return
        if (!route) {
          refuseSocks(socket, socksReply(SOCKS_REFUSED))
          return
        }
        socket.write(socksReply(0))
        opts.onConnection?.()
        bridge(socket, route.target, route.spec, opts)
        return
      }
      const upstream = await dialElsewhere(request.host, request.port)
      if (socket.destroyed || !upstream) {
        upstream?.destroy()
        if (!socket.destroyed) refuseSocks(socket, socksReply(SOCKS_REFUSED))
        return
      }
      socket.write(socksReply(0))
      socket.pipe(upstream).pipe(socket)
      upstream.on('error', () => socket.destroy())
      upstream.on('close', () => socket.destroy())
      socket.on('close', () => upstream.destroy())
    })
  })
}

/** `pending`, or undefined once a connection's head would have timed out. */
async function withinHeadTimeout<T>(pending: Promise<T>): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), HEAD_TIMEOUT_MS) })
  try {
    return await Promise.race([pending, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Connect to `host`, unless any address it resolves to is this machine's:
 * loopback, unspecified (`0.0.0.0` and `::` reach local listeners), or one
 * of its interfaces. Other hosts on its networks, its containers and VMs
 * among them, are dialed like any other. Resolves undefined when refused or
 * unreachable.
 */
async function dialElsewhere(host: string, port: number): Promise<net.Socket | undefined> {
  const addresses = await withinHeadTimeout(lookup(host, { all: true }).catch(() => []))
  if (!addresses?.length || addresses.some((a) => isThisMachine(a.address))) return undefined
  return new Promise((resolve) => {
    // Every vetted address in turn, as Chromium would (Happy Eyeballs),
    // with no second lookup between the check and the connect.
    const upstream = net.connect({
      host,
      port,
      autoSelectFamily: true,
      lookup: (_name, options, callback) => {
        if (options.all) callback(null, addresses)
        else callback(null, addresses[0].address, addresses[0].family)
      },
    })
    upstream.setTimeout(HEAD_TIMEOUT_MS, () => upstream.destroy(new Error('connect timed out')))
    upstream.once('connect', () => {
      upstream.setTimeout(0)
      resolve(upstream)
    })
    upstream.once('error', () => resolve(undefined))
  })
}

function isThisMachine(address: string): boolean {
  const local = new net.BlockList()
  local.addSubnet('127.0.0.0', 8, 'ipv4')
  local.addSubnet('0.0.0.0', 8, 'ipv4')
  local.addAddress('::1', 'ipv6')
  local.addAddress('::', 'ipv6')
  for (const a of Object.values(os.networkInterfaces()).flat()) {
    if (a) local.addAddress(a.address, a.family === 'IPv4' ? 'ipv4' : 'ipv6')
  }
  // IPv4-mapped IPv6 addresses match the IPv4 rules.
  const bare = address.replace(/%.*$/, '')
  return local.check(bare, net.isIPv6(bare) ? 'ipv6' : 'ipv4')
}

/** A name every browser resolves to this machine, absolute (a trailing
 *  dot) or not. Chromium hands the proxy names, `[::1]` as `::1`, and
 *  resolves none itself. */
function isLoopbackName(host: string): boolean {
  const name = host.replace(/\.$/, '')
  return name === 'localhost' || name.endsWith('.localhost') || name === '::1' || /^127\.\d+\.\d+\.\d+$/.test(name)
}

function socksReply(code: number): Buffer {
  return Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0])
}

/** Answer with `reply` and close, reading on so the peer's close is seen. */
function refuseSocks(socket: net.Socket, reply: Buffer): void {
  socket.on('error', () => { /* the peer may already be gone */ })
  socket.resume()
  socket.end(reply)
}

/**
 * Take a new connection through the SOCKS5 greeting (no authentication)
 * and read its request. Resolves the host and port of a CONNECT to a name
 * or an IPv4 address, leaving the socket paused with any later bytes put
 * back. Anything else is answered with a refusal and resolves null, as
 * does a connection that closes or stalls first.
 */
function readSocksConnect(socket: net.Socket): Promise<{ host: string; port: number } | null> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0)
    let greeted = false
    const finish = (request: { host: string; port: number; rest: Buffer } | null, reply?: Buffer): void => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('end', onGone)
      socket.off('error', onGone)
      socket.pause()
      if (!request) {
        if (reply) refuseSocks(socket, reply)
        else socket.destroy()
        resolve(null)
        return
      }
      if (request.rest.length > 0) socket.unshift(request.rest)
      resolve({ host: request.host, port: request.port })
    }
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk])
      if (!greeted) {
        if (buf.length < 2 || buf.length < 2 + buf[1]) return
        if (buf[0] !== 5 || !buf.subarray(2, 2 + buf[1]).includes(0)) {
          finish(null, Buffer.from([5, 0xff]))
          return
        }
        buf = buf.subarray(2 + buf[1])
        greeted = true
        socket.write(Buffer.from([5, 0]))
      }
      // VER CMD RSV ATYP ADDR PORT, ADDR a length-prefixed name (3) or IPv4 (1).
      if (buf.length < 5) return
      const atyp = buf[3]
      const addrEnd = atyp === 3 ? 5 + buf[4] : atyp === 1 ? 8 : -1
      if (buf[0] !== 5 || buf[1] !== 1 || addrEnd < 0) {
        finish(null, socksReply(SOCKS_REFUSED))
        return
      }
      if (buf.length < addrEnd + 2) return
      const host = atyp === 3 ? buf.subarray(5, addrEnd).toString('latin1') : [...buf.subarray(4, 8)].join('.')
      finish({ host, port: buf.readUInt16BE(addrEnd), rest: buf.subarray(addrEnd + 2) })
    }
    const onGone = (): void => finish(null)
    const timer = setTimeout(onGone, HEAD_TIMEOUT_MS)
    socket.on('data', onData)
    socket.once('end', onGone)
    socket.once('error', onGone)
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
