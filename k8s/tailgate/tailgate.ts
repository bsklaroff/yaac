/**
 * tailgate: the tailnet site tunnel's gateway (docs/public-sites.md
 * "Tailnet sites"). tailscaled forwards the device's 443 and 80 here, each
 * connection behind a PROXY header naming the caller's tailnet address.
 *
 * That header is believed only because nothing but tailscaled's serve can
 * open the listeners that read it: they bind 127.0.0.2, while userspace
 * tailscaled hands every other port of the device to the same port on
 * 127.0.0.1 or ::1. A peer dialing the device's 8443 directly therefore
 * reaches nothing, and cannot name a caller.
 *
 *  - On 443 it ends TLS with the site domain's wildcard certificate, asks
 *    tailscaled who holds the caller's address, and forwards each request
 *    and WebSocket upgrade to the router's tailnet listener with `Host`
 *    unchanged, stamped with the caller's login. A tagged device, which
 *    acts for no user, gets a 403.
 *  - On 80 it redirects to `https://`.
 *  - On both it closes a connection once no bytes have moved for `idleMs`,
 *    with no overall deadline, so long uploads and WebSockets stay up.
 *  - It answers DNS for the zone (dns.ts) and a readiness probe.
 *
 * It holds no list of sites: the router answers 404 for a name no site has.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import tls from 'node:tls'
import { startDns } from './dns'
import { readProxyHeader, type ProxyHeader } from './proxy-header'
import { ownAddresses, whois, type TailnetUser } from './tailscaled'

export interface TailgateConfig {
  siteDomain: string
  tailscaleSocket: string
  router: { host: string; port: number }
  /** A mounted `kubernetes.io/tls` Secret: `tls.crt` and `tls.key`. */
  tlsDir: string
  /** Where tailscaled's serve forwards 443 and 80, behind a PROXY header:
   *  a loopback address its forward of other ports never dials. */
  serveHost: string
  /** Where 53 arrives, forwarded by tailscaled like any port serve leaves. */
  dnsHost: string
  httpsPort: number
  httpPort: number
  dnsPort: number
  /** The readiness probe's listener, on every address for the kubelet. */
  healthPort: number
  /** How long a connection on 443 or 80 may go with no bytes moving before
   *  it is closed. */
  idleMs: number
  /** How often the certificate and the device's addresses are re-read. */
  pollMs: number
}

/**
 * Hop-by-hop headers, which a proxy never forwards. `Transfer-Encoding` is
 * not among them on the way up: a chunked request body is re-chunked to the
 * router, so it stays framed and cannot carry a second request of its own.
 */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'upgrade',
])
const RESPONSE_HOP_BY_HOP = new Set([...HOP_BY_HOP, 'transfer-encoding'])

/**
 * A header value as Tailscale's own proxies send one: plain when it is
 * printable ASCII, else RFC 2047 Q-encoded UTF-8, since header values are
 * Latin-1 on the wire.
 */
export function encodeHeaderValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value
  const q = [...Buffer.from(value, 'utf8')]
    .map((b) => (/[A-Za-z0-9!*+\-/]/.test(String.fromCharCode(b)) ? String.fromCharCode(b)
      : b === 0x20 ? '_' : `=${b.toString(16).toUpperCase().padStart(2, '0')}`))
    .join('')
  return `=?utf-8?q?${q}?=`
}

/**
 * The headers forwarded to the router: the client's, minus hop-by-hop ones
 * (bar `keepHop`, for an upgrade) and every `Tailscale-*` and forwarding
 * header it sent, plus the caller's login and address. tailgate is the router's
 * one trusted hop, so the `X-Forwarded-For` it sets is the client address.
 */
function stampedHeaders(
  raw: string[],
  user: TailnetUser,
  caller: ProxyHeader,
  keepHop: boolean,
): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i].toLowerCase()
    if (name.startsWith('tailscale-') || name.startsWith('x-forwarded-')) continue
    if (!keepHop && HOP_BY_HOP.has(name)) continue
    out.push([raw[i], raw[i + 1]])
  }
  out.push(
    ['Tailscale-User-Login', encodeHeaderValue(user.login)],
    ['Tailscale-User-Name', encodeHeaderValue(user.name)],
    ['X-Forwarded-For', caller.address],
    ['X-Forwarded-Proto', 'https'],
  )
  return out
}

/** A response's status line and headers, as raw HTTP/1.1, closing the
 *  connection unless it is a 101. */
function responseHead(res: http.IncomingMessage): string {
  const lines = [`HTTP/1.1 ${String(res.statusCode ?? 502)} ${res.statusMessage ?? ''}`]
  for (let i = 0; i < res.rawHeaders.length; i += 2) {
    const name = res.rawHeaders[i].toLowerCase()
    if (res.statusCode !== 101 && (name === 'connection' || name === 'keep-alive')) continue
    lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`)
  }
  if (res.statusCode !== 101) lines.push('connection: close')
  return `${lines.join('\r\n')}\r\n\r\n`
}

function refuse(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' })
  res.end(`${message}\n`)
}

export async function startTailgate(config: TailgateConfig): Promise<{
  ports: { https: number; http: number; dns: number; health: number }
  close: () => Promise<void>
}> {
  let secureContext: tls.SecureContext | null = null
  let certPem = ''
  let addresses: string[] = []

  /**
   * Read the certificate when it changed, keeping the last good one until
   * the new certificate and key are whole and match, so a read caught
   * between the two files' writes changes nothing.
   */
  const refreshCert = async (): Promise<void> => {
    try {
      const [cert, key] = await Promise.all([
        fs.readFile(path.join(config.tlsDir, 'tls.crt'), 'utf8'),
        fs.readFile(path.join(config.tlsDir, 'tls.key'), 'utf8'),
      ])
      if (cert + key === certPem) return
      if (!new crypto.X509Certificate(cert).checkPrivateKey(crypto.createPrivateKey(key))) {
        throw new Error('tls.crt does not match tls.key')
      }
      secureContext = tls.createSecureContext({ cert, key })
      certPem = cert + key
      console.log('[tailgate] loaded the certificate')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[tailgate] certificate: ${String(err)}`)
    }
  }
  const refreshAddresses = async (): Promise<void> => {
    try {
      addresses = await ownAddresses(config.tailscaleSocket)
    } catch (err) {
      console.error(`[tailgate] tailscaled status: ${String(err)}`)
    }
  }
  await Promise.all([refreshCert(), refreshAddresses()])
  const poll = setInterval(() => { void refreshCert(); void refreshAddresses() }, config.pollMs)

  /** The caller of each TLS connection, null when it acts for no user. */
  const callers = new WeakMap<net.Socket, { caller: ProxyHeader; user: TailnetUser | null }>()

  const app = http.createServer((req, res) => {
    const who = callers.get(req.socket)
    if (!who?.user) {
      refuse(res, 403, 'Tailnet sites answer only tailnet users; this device acts for no user.')
      return
    }
    const upstream = http.request({
      host: config.router.host,
      port: config.router.port,
      method: req.method,
      path: req.url,
      headers: stampedHeaders(req.rawHeaders, who.user, who.caller, false).flat(),
    }, (up) => {
      const headers: string[] = []
      for (let i = 0; i < up.rawHeaders.length; i += 2) {
        if (!RESPONSE_HOP_BY_HOP.has(up.rawHeaders[i].toLowerCase())) headers.push(up.rawHeaders[i], up.rawHeaders[i + 1])
      }
      res.writeHead(up.statusCode ?? 502, up.statusMessage, headers)
      up.pipe(res)
    })
    upstream.on('error', () => {
      if (!res.headersSent) refuse(res, 502, 'The site router did not answer.')
      else res.destroy()
    })
    req.pipe(upstream)
  })
  // A WebSocket (or any) upgrade goes up stamped. The two sockets are
  // joined only once the router answers 101: any other answer is relayed
  // and the connection closed, so no unparsed byte reaches the router.
  app.on('upgrade', (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    const who = callers.get(socket)
    if (!who?.user) {
      socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
      return
    }
    const upstream = http.request({
      host: config.router.host,
      port: config.router.port,
      method: req.method,
      path: req.url,
      headers: stampedHeaders(req.rawHeaders, who.user, who.caller, true).flat(),
      // A connection of its own, never pooled: after a refused upgrade the
      // router may still be reading it as a stream.
      agent: false,
    })
    upstream.on('upgrade', (res, upSocket, upHead) => {
      socket.write(responseHead(res))
      if (upHead.length > 0) socket.write(upHead)
      if (head.length > 0) upSocket.write(head)
      upSocket.pipe(socket)
      socket.pipe(upSocket)
      upSocket.on('error', () => socket.destroy())
      socket.on('close', () => upSocket.destroy())
    })
    upstream.on('response', (res) => {
      socket.write(responseHead(res))
      res.pipe(socket, { end: false })
      res.on('end', () => {
        socket.end()
        upstream.destroy()
      })
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
    upstream.end()
  })

  /**
   * Every open connection, destroyed on close, and once it has gone
   * `idleMs` with no bytes moving. Node's own HTTP timeouts for an unfinished
   * request head run only on a server that listens, which `app` never does,
   * so without this a client that vanished before finishing a request would
   * hold its connection for good.
   */
  const open = new Set<net.Socket>()
  const track = (raw: net.Socket): void => {
    open.add(raw)
    raw.on('close', () => open.delete(raw))
    raw.setTimeout(config.idleMs, () => raw.destroy())
  }

  const https = net.createServer((raw) => {
    track(raw)
    raw.on('error', () => raw.destroy())
    void (async () => {
      const { caller, stream } = await readProxyHeader(raw)
      if (!secureContext) {
        raw.destroy()
        return
      }
      const user = await whois(config.tailscaleSocket, caller.address, caller.port)
      const socket = new tls.TLSSocket(stream, { isServer: true, secureContext })
      socket.on('error', () => socket.destroy())
      callers.set(socket, { caller, user })
      app.emit('connection', socket)
    })().catch((err: unknown) => {
      console.error(`[tailgate] connection: ${String(err)}`)
      raw.destroy()
    })
  })

  // Plain HTTP only ever redirects, so it reads just the request head.
  const redirect = net.createServer((raw) => {
    track(raw)
    raw.on('error', () => raw.destroy())
    void readProxyHeader(raw).then(({ stream }) => {
      let head = ''
      stream.setEncoding('latin1')
      stream.on('data', (chunk: string) => {
        head += chunk
        if (!head.includes('\r\n\r\n')) {
          if (head.length > 16_384) stream.destroy()
          return
        }
        const target = /^[A-Z]+ (\/\S*) HTTP\//.exec(head)?.[1] ?? '/'
        const host = (/\r\nhost:[ \t]*([^\r\n]+)/i.exec(head)?.[1] ?? '').trim().replace(/:\d+$/, '')
        const ok = host === config.siteDomain || host.endsWith(`.${config.siteDomain}`)
        stream.end(ok
          ? `HTTP/1.1 308 Permanent Redirect\r\nlocation: https://${host}${target}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`
          : 'HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n')
      })
      stream.on('error', () => stream.destroy())
    }, () => raw.destroy())
  })

  const health = http.createServer((req, res) => {
    const ready = secureContext !== null && addresses.length > 0
    res.writeHead(req.url === '/ready' && ready ? 200 : 503, { 'content-type': 'text/plain' })
    res.end(ready ? 'ready\n' : `${secureContext ? '' : 'no certificate; '}${addresses.length ? '' : 'no tailnet address'}\n`)
  })

  const listen = (server: net.Server, port: number, host: string): Promise<number> =>
    new Promise((resolve) => server.listen(port, host, () => resolve((server.address() as net.AddressInfo).port)))
  const dns = await startDns({ host: config.dnsHost, port: config.dnsPort, zone: config.siteDomain, addresses: () => addresses })
  const ports = {
    https: await listen(https, config.httpsPort, config.serveHost),
    http: await listen(redirect, config.httpPort, config.serveHost),
    dns: dns.port,
    health: await listen(health, config.healthPort, '0.0.0.0'),
  }
  return {
    ports,
    close: async () => {
      clearInterval(poll)
      for (const raw of open) raw.destroy()
      await dns.close()
      for (const server of [https, redirect, health, app]) {
        if ('closeAllConnections' in server) server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
      }
    },
  }
}
