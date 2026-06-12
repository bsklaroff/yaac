/**
 * yaac per-pod egress relay (TypeScript / Node).
 *
 * The session pod's redirect init container REDIRECTs outbound tcp/443 to
 * this relay's HTTPS listener and tcp/80 to its HTTP listener, both on
 * 127.0.0.1. Splitting the protocols across two loopback ports is what
 * lets the relay stay pure Node: it learns the original protocol from
 * which listener accepted the connection, so it never needs
 * SO_ORIGINAL_DST (a getsockopt the Go version used and the only reason
 * that version existed). For each connection the relay dials the shared
 * MITM proxy's transparent listener for that protocol and prepends a
 * PROXY-protocol-v2 header whose TLV carries "<sessionId>:<token>"; the
 * proxy verifies the token, so a pod that merely reaches the transparent
 * port gets nothing without it. Identity is a per-connection secret held
 * by this container, which the workload (a different container, separate
 * env) cannot read.
 *
 * A fourth listener is a UDP DNS stub: the redirect init container also
 * REDIRECTs outbound udp/53 here, and the stub answers every A query with
 * a fixed dummy IP (resolution must succeed before a client dials, but the
 * resolved address is decorative — the 443/80 REDIRECT ignores it and the
 * proxy routes by SNI/Host). DNS never leaves the pod. The relay itself
 * needs no resolution either: PROXY_HOST carries the proxy Service's
 * pinned ClusterIP, not a DNS name.
 *
 * Listens on 127.0.0.1 only — security-critical: a pod's NetworkPolicy is
 * Egress-only, so a relay reachable on the pod IP would let any in-cluster
 * peer tunnel out under this session's credential.
 *
 * A dumb authenticated splice: no TLS, no SNI parsing, no allowlist. Every
 * policy decision stays in the shared proxy.
 */

import net from 'node:net'
import dgram from 'node:dgram'
import fs from 'node:fs'
import { buildPp2Header } from './pp2-frame'
import { buildDnsResponse, parseDnsQuery } from './dns-stub'

/**
 * Fixed answer for every A query — RFC 2544 benchmark range, never
 * routable. A const, not config: nothing anywhere should route to it.
 */
const DNS_DUMMY_IPV4 = '198.18.0.1'

/**
 * Loopback UDP DNS stub. Replies route back through conntrack's
 * un-REDIRECT, so clients see them arrive from the resolver VIP they
 * queried. UDP only: our tiny answers never set TC, so resolvers never
 * fall back to tcp/53 (which the pod's egress filter REJECTs).
 */
function startDnsStub(port: number, onListen: () => void): void {
  const socket = dgram.createSocket('udp4')
  socket.on('message', (msg, rinfo) => {
    const query = parseDnsQuery(msg)
    if (!query) return // not a well-formed single-question query: drop
    socket.send(buildDnsResponse(query, DNS_DUMMY_IPV4), rinfo.port, rinfo.address)
  })
  socket.on('error', (err) => {
    console.error(`[relay] dns stub ${port} error:`, err.message)
    process.exit(1)
  })
  socket.bind(port, '127.0.0.1', onListen)
}

function reqEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`[relay] required env ${name} is not set`)
    process.exit(1)
  }
  return v
}

const httpsListenPort = Number(reqEnv('LISTEN_HTTPS_PORT'))

// Probe mode (cluster check): listen on the HTTPS port, report the first
// connection, and exit — proves the pod-netns REDIRECT delivers to the
// relay without standing up a proxy. Needs only LISTEN_HTTPS_PORT; when
// LISTEN_DNS_PORT is also set, the DNS stub comes up too so the check can
// gate on udp/53 interception end to end.
if (process.env.RELAY_PROBE === '1') {
  const probeDnsPort = process.env.LISTEN_DNS_PORT
  if (probeDnsPort) {
    startDnsStub(Number(probeDnsPort), () => {
      console.log(`[relay] probe dns stub on 127.0.0.1:${probeDnsPort}`)
    })
  }
  const server = net.createServer((sock) => {
    console.log('REDIRECT_OK')
    sock.destroy()
    server.close()
    process.exit(0)
  })
  server.listen(httpsListenPort, '127.0.0.1', () => {
    console.log(`[relay] probe listening on 127.0.0.1:${httpsListenPort}`)
  })
} else {
  main()
}

function main(): void {
  const httpListenPort = Number(reqEnv('LISTEN_HTTP_PORT'))
  const connectListenPort = Number(reqEnv('LISTEN_CONNECT_PORT'))
  const dnsListenPort = Number(reqEnv('LISTEN_DNS_PORT'))
  const proxyHost = reqEnv('PROXY_HOST')
  const upstreamHttpsPort = Number(reqEnv('TRANSPARENT_HTTPS_PORT'))
  const upstreamHttpPort = Number(reqEnv('TRANSPARENT_HTTP_PORT'))
  const upstreamTunnelPort = Number(reqEnv('TRANSPARENT_TUNNEL_PORT'))
  const identity = `${reqEnv('SESSION_ID')}:${reqEnv('RELAY_TOKEN')}`
  // Written after all four sockets bind; the pod's startupProbe checks it,
  // since the relay binds loopback (a tcpSocket probe dials the pod IP).
  const readyFile = process.env.READY_FILE ?? '/tmp/yaac-relay-ready'

  const makeListener = (listenPort: number, upstreamPort: number, origDstPort: number): net.Server => {
    const server = net.createServer((client) => {
      const upstream = net.connect(upstreamPort, proxyHost, () => {
        // PROXY header first, then splice the client's bytes after it.
        upstream.write(buildPp2Header({ dstPort: origDstPort, identity }))
        client.pipe(upstream)
        upstream.pipe(client)
      })
      client.on('error', () => upstream.destroy())
      upstream.on('error', () => client.destroy())
    })
    server.on('error', (err) => {
      console.error(`[relay] listener ${listenPort} error:`, err.message)
      process.exit(1)
    })
    return server
  }

  const httpsServer = makeListener(httpsListenPort, upstreamHttpsPort, 443)
  const httpServer = makeListener(httpListenPort, upstreamHttpPort, 80)
  // SSH: git's ncat ProxyCommand connects here and sends a CONNECT; the
  // relay is a dumb PP2-prefixing pipe (the proxy's tunnel listener parses
  // the CONNECT and tunnels), so it needs no origDstPort hint.
  const connectServer = makeListener(connectListenPort, upstreamTunnelPort, 0)

  const servers: Array<[net.Server, number]> = [
    [httpsServer, httpsListenPort],
    [httpServer, httpListenPort],
    [connectServer, connectListenPort],
  ]
  let up = 0
  const totalListeners = servers.length + 1 // + the UDP DNS stub
  const onListen = (): void => {
    if (++up < totalListeners) return
    try { fs.writeFileSync(readyFile, 'ready') } catch { /* probe will retry */ }
    console.log(`[relay] listening 127.0.0.1: ${httpsListenPort}->${upstreamHttpsPort} `
      + `${httpListenPort}->${upstreamHttpPort} ${connectListenPort}->${upstreamTunnelPort} `
      + `dns:${dnsListenPort}; upstream ${proxyHost}`)
  }
  startDnsStub(dnsListenPort, onListen)
  for (const [srv, port] of servers) srv.listen(port, '127.0.0.1', onListen)
}
