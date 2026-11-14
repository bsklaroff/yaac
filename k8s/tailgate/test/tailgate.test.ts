/**
 * tailgate end to end on real sockets: a stand-in for tailscaled's local
 * API on a unix socket, a router that echoes what reaches it, and real TLS
 * with certificates made by openssl.
 */
import { execFileSync } from 'node:child_process'
import dgram from 'node:dgram'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTailgate } from 'yaac-tailgate/tailgate'

const ZONE = 'apps.example.com'
const SITE = `shop.${ZONE}`
const ALICE = '100.64.0.1'
const TAGGED = '100.64.0.2'
/** Short, so the idle timeout can be watched; long enough that no other
 *  case's connection sits quiet that long. */
const IDLE_MS = 1000

let dir: string
let tlsDir: string
let gate: Awaited<ReturnType<typeof startTailgate>>
let tailscaled: http.Server
let router: http.Server
const routerHits: Array<{ url?: string; headers: http.IncomingHttpHeaders }> = []
/** Bytes that reached the router on an upgrade it refused. */
let afterRefusal = ''
/** The router's upgraded sockets, which closing its server leaves open. */
const upgraded: net.Socket[] = []

function makeCert(cn: string): { cert: string; key: string } {
  const out = path.join(dir, cn)
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-subj', `/CN=${cn}`, '-keyout', `${out}.key`, '-out', `${out}.crt`,
  ], { stdio: 'ignore' })
  return { cert: execFileSync('cat', [`${out}.crt`]).toString(), key: execFileSync('cat', [`${out}.key`]).toString() }
}

async function installCert(cn: string): Promise<void> {
  const { cert, key } = makeCert(cn)
  await fs.writeFile(path.join(tlsDir, 'tls.key'), key)
  await fs.writeFile(path.join(tlsDir, 'tls.crt'), cert)
}

async function until(probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15_000
  while (!await probe()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function ready(): Promise<number> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${String(gate.ports.health)}/ready`, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    }).on('error', reject)
  })
}

/** Open a connection as tailscaled's serve does: the PROXY line naming `caller`, then the client's bytes. */
function dialAs(caller: string, port: number, host = '127.0.0.2'): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const raw = net.connect(port, host, () => {
      raw.write(`PROXY TCP4 ${caller} 100.64.0.9 41000 ${String(port)}\r\n`)
      resolve(raw)
    })
    raw.on('error', reject)
  })
}

async function tlsAs(caller: string): Promise<tls.TLSSocket> {
  const raw = await dialAs(caller, gate.ports.https)
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ socket: raw, servername: SITE, rejectUnauthorized: false }, () => resolve(socket))
    socket.on('error', reject)
  })
}

/** Send `request` and read until the server closes. */
function exchange(socket: net.Socket, request: string): Promise<string> {
  return new Promise((resolve) => {
    let out = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => { out += chunk })
    socket.on('close', () => resolve(out))
    socket.write(request)
  })
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tailgate-'))
  tlsDir = path.join(dir, 'tls')
  await fs.mkdir(tlsDir)

  // tailscaled's local API: its own addresses, and whois for a user's
  // device, a tagged device and anything else.
  const socketPath = path.join(dir, 'tailscaled.sock')
  tailscaled = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local-tailscaled.sock')
    if (req.headers.host !== 'local-tailscaled.sock') {
      res.writeHead(403).end()
    } else if (url.pathname === '/localapi/v0/status') {
      res.end(JSON.stringify({ TailscaleIPs: ['100.64.0.9', 'fd7a:115c:a1e0::9'] }))
    } else if (url.pathname === '/localapi/v0/whois') {
      const ip = url.searchParams.get('addr')?.split(':')[0]
      if (ip === ALICE) res.end(JSON.stringify({ Node: {}, UserProfile: { LoginName: 'alice@example.com', DisplayName: 'Alice Ünal' } }))
      else if (ip === TAGGED) res.end(JSON.stringify({ Node: { Tags: ['tag:ci'] }, UserProfile: { LoginName: 'tagged-devices' } }))
      else res.writeHead(404).end('no match')
    } else {
      res.writeHead(404).end()
    }
  })
  await new Promise<void>((resolve) => tailscaled.listen(socketPath, resolve))

  router = http.createServer((req, res) => {
    routerHits.push({ url: req.url, headers: req.headers })
    res.end(JSON.stringify({ host: req.headers.host, headers: req.headers }))
  })
  router.on('upgrade', (req: http.IncomingMessage, socket: net.Socket) => {
    upgraded.push(socket)
    routerHits.push({ url: req.url, headers: req.headers })
    if (req.url === '/plain') {
      // A site that does not speak WebSocket, keeping the connection open.
      socket.on('data', (chunk: Buffer) => { afterRefusal += chunk.toString() })
      socket.write('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nno')
      return
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n')
    socket.pipe(socket)
  })
  await new Promise<void>((resolve) => router.listen(0, '127.0.0.1', resolve))

  gate = await startTailgate({
    siteDomain: ZONE,
    tailscaleSocket: socketPath,
    router: { host: '127.0.0.1', port: (router.address() as net.AddressInfo).port },
    tlsDir,
    serveHost: '127.0.0.2',
    dnsHost: '127.0.0.1',
    httpsPort: 0,
    httpPort: 0,
    dnsPort: 0,
    healthPort: 0,
    idleMs: IDLE_MS,
    pollMs: 20,
  })
})

afterAll(async () => {
  await gate.close()
  router.closeAllConnections()
  for (const socket of upgraded) socket.destroy()
  await new Promise((resolve) => router.close(resolve))
  await new Promise((resolve) => tailscaled.close(resolve))
  await fs.rm(dir, { recursive: true, force: true })
})

describe('startTailgate', () => {
  it('is not ready and serves no TLS until the certificate Secret is filled, then serves the certificate it holds', async () => {
    expect(await ready()).toBe(503)
    const refused = await dialAs(ALICE, gate.ports.https)
    await new Promise((resolve) => refused.on('close', resolve))

    await installCert('first.example')
    await until(async () => await ready() === 200)
    const first = await tlsAs(ALICE)
    expect(first.getPeerCertificate().subject.CN).toBe('first.example')
    first.destroy()

    // A changed Secret is picked up without a restart.
    await installCert(`*.${ZONE}`)
    await until(async () => {
      const socket = await tlsAs(ALICE)
      const cn = socket.getPeerCertificate().subject.CN
      socket.destroy()
      return cn === `*.${ZONE}`
    })
  })

  it('stamps a user\'s requests with their login, replacing what the client sent, and refuses a caller with no user', async () => {
    const response = await exchange(await tlsAs(ALICE), [
      'GET /cart?x=1 HTTP/1.1',
      `Host: ${SITE}`,
      'Tailscale-User-Login: mallory@example.com',
      'tailscale-user-profile-pic: https://evil',
      'Tailscale-App-Capabilities: {"example.com/cap/admin":[{}]}',
      'Tailscale-Headers-Info: https://evil',
      'X-Forwarded-For: 203.0.113.9',
      'X-Forwarded-Host: evil.example',
      'Connection: close',
      '', '',
    ].join('\r\n'))
    expect(response).toMatch(/^HTTP\/1\.1 200/)
    const seen = JSON.parse(response.slice(response.indexOf('\r\n\r\n') + 4)) as { host: string; headers: Record<string, string> }
    expect(seen.host).toBe(SITE)
    expect(seen.headers).toMatchObject({
      'tailscale-user-login': 'alice@example.com',
      'tailscale-user-name': '=?utf-8?q?Alice_=C3=9Cnal?=',
      'x-forwarded-for': ALICE,
      'x-forwarded-proto': 'https',
    })
    for (const forged of ['tailscale-user-profile-pic', 'tailscale-app-capabilities', 'tailscale-headers-info']) {
      expect(seen.headers).not.toHaveProperty(forged)
    }
    expect(seen.headers).not.toHaveProperty('x-forwarded-host')
    expect(routerHits.at(-1)?.url).toBe('/cart?x=1')

    // A tagged device and an address the tailnet does not know reach nothing.
    const hits = routerHits.length
    for (const caller of [TAGGED, '100.64.0.77']) {
      const refused = await exchange(await tlsAs(caller), `GET / HTTP/1.1\r\nHost: ${SITE}\r\nConnection: close\r\n\r\n`)
      expect(refused).toMatch(/^HTTP\/1\.1 403/)
    }
    expect(routerHits.length).toBe(hits)
  })

  it('keeps a chunked body framed, so it cannot carry a second, unstamped request to the router', async () => {
    const hits = routerHits.length
    const smuggled = `POST /admin HTTP/1.1\r\nHost: ${SITE}\r\nTailscale-User-Login: ceo@example.com\r\nContent-Length: 0\r\n\r\n`
    const reply = await exchange(await tlsAs(ALICE), [
      'GET / HTTP/1.1', `Host: ${SITE}`, 'Transfer-Encoding: chunked', 'Connection: close', '',
      `${smuggled.length.toString(16)}\r\n${smuggled}\r\n0\r\n\r\n`,
    ].join('\r\n'))
    expect(reply).toMatch(/^HTTP\/1\.1 200/)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(routerHits.slice(hits).map((h) => [h.url, h.headers['tailscale-user-login']])).toEqual([['/', 'alice@example.com']])
  })

  it('accepts a PROXY header only where tailscaled\'s serve connects, not where it forwards any other port', async () => {
    // A peer dialing the device's 8443 directly lands on 127.0.0.1, where
    // nothing listens, so it cannot name another user as its caller.
    await expect(dialAs(ALICE, gate.ports.https, '127.0.0.1')).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })

  it('relays an upgrade the router refuses and closes, so nothing sent after it reaches the router', async () => {
    const socket = await tlsAs(ALICE)
    socket.setEncoding('utf8')
    let got = ''
    socket.on('data', (chunk: string) => { got += chunk })
    const closed = new Promise((resolve) => socket.on('close', resolve))
    socket.write(['GET /plain HTTP/1.1', `Host: ${SITE}`, 'Upgrade: websocket', 'Connection: Upgrade', '', ''].join('\r\n'))
    await until(() => Promise.resolve(got.includes('no')))
    expect(got).toMatch(/^HTTP\/1\.1 200/)
    if (!socket.destroyed) socket.write(`POST /admin HTTP/1.1\r\nHost: ${SITE}\r\nTailscale-User-Login: ceo@example.com\r\n\r\n`)
    await closed
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(afterRefusal).toBe('')
  })

  it('carries a stamped WebSocket upgrade through to the router and joins the two sockets', async () => {
    const socket = await tlsAs(ALICE)
    socket.setEncoding('utf8')
    let got = ''
    socket.on('data', (chunk: string) => { got += chunk })
    socket.write([
      'GET /live HTTP/1.1', `Host: ${SITE}`, 'Upgrade: websocket', 'Connection: Upgrade',
      'Tailscale-User-Login: mallory@example.com', '', '',
    ].join('\r\n'))
    await until(() => Promise.resolve(got.includes('\r\n\r\n')))
    expect(got).toMatch(/^HTTP\/1\.1 101/)
    expect(routerHits.at(-1)?.headers).toMatchObject({ 'tailscale-user-login': 'alice@example.com', upgrade: 'websocket' })
    socket.write('ping')
    await until(() => Promise.resolve(got.endsWith('ping')))
    socket.destroy()
  })

  it('redirects plain HTTP under the zone to https, and nothing else', async () => {
    const redirected = await exchange(await dialAs(ALICE, gate.ports.http), `GET /a?b=1 HTTP/1.1\r\nHost: ${SITE}\r\n\r\n`)
    expect(redirected).toMatch(/^HTTP\/1\.1 308/)
    expect(redirected).toContain(`location: https://${SITE}/a?b=1`)
    const other = await exchange(await dialAs(ALICE, gate.ports.http), 'GET / HTTP/1.1\r\nHost: example.org\r\n\r\n')
    expect(other).toMatch(/^HTTP\/1\.1 404/)
  })

  it('closes a connection once no bytes have moved for the idle timeout, however long it has been open', async () => {
    // One that never finishes a request, and so has no HTTP timeout of
    // Node's to end it: on 443 a client stalled mid request head after the
    // handshake, on 80 one that sends nothing after the PROXY line.
    const midHead = async (): Promise<net.Socket> => {
      const socket = await tlsAs(ALICE)
      socket.on('data', () => {})
      socket.write(`GET /x HTTP/1.1\r\nHost: ${SITE}\r\nX-Partial: `)
      return socket
    }
    for (const open of [midHead, () => dialAs(ALICE, gate.ports.http)]) {
      const stalled = await open()
      const opened = Date.now()
      await new Promise((resolve) => stalled.on('close', resolve))
      expect(Date.now() - opened).toBeGreaterThanOrEqual(IDLE_MS - 100)
    }

    // A WebSocket that keeps talking outlives it, then goes once it falls quiet.
    const socket = await tlsAs(ALICE)
    socket.setEncoding('utf8')
    let got = ''
    socket.on('data', (chunk: string) => { got += chunk })
    const closed = new Promise((resolve) => socket.on('close', resolve))
    socket.write(['GET /live HTTP/1.1', `Host: ${SITE}`, 'Upgrade: websocket', 'Connection: Upgrade', '', ''].join('\r\n'))
    await until(() => Promise.resolve(got.includes('\r\n\r\n')))
    for (let i = 1; i <= 4; i++) {
      await new Promise((resolve) => setTimeout(resolve, IDLE_MS / 2))
      socket.write('ping')
      await until(() => Promise.resolve(got.split('ping').length - 1 === i))
    }
    expect(socket.destroyed).toBe(false)
    const quiet = Date.now()
    await closed
    expect(Date.now() - quiet).toBeGreaterThanOrEqual(IDLE_MS - 100)
    // The router's end of the joined pair is let go with it.
    await until(() => Promise.resolve(upgraded.at(-1)?.destroyed === true))
  })

  it('answers DNS for names under the zone with its own tailnet addresses, over UDP and TCP, and refuses other names', async () => {
    const query = (name: string, qtype: number): Buffer => {
      const header = Buffer.from([0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0])
      const qname = Buffer.concat([...name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])])
      return Buffer.concat([header, qname, Buffer.from([0, qtype, 0, 1])])
    }
    const udp = (msg: Buffer): Promise<Buffer> => new Promise((resolve) => {
      const client = dgram.createSocket('udp4')
      client.on('message', (reply) => {
        client.close()
        resolve(reply)
      })
      client.send(msg, gate.ports.dns, '127.0.0.1')
    })
    const rcode = (reply: Buffer): number => reply.readUInt16BE(2) & 0xf

    const a = await udp(query(`Shop.${ZONE}`, 1))
    expect(rcode(a)).toBe(0)
    expect(a.readUInt16BE(6)).toBe(1)
    expect([...a.subarray(a.length - 4)]).toEqual([100, 64, 0, 9])

    const aaaa = await udp(query(`nosuchsite.${ZONE}`, 28))
    expect(aaaa.readUInt16BE(6)).toBe(1)
    expect(aaaa.subarray(aaaa.length - 16).toString('hex')).toBe('fd7a115ca1e000000000000000000009')

    const refused = await udp(query('example.org', 1))
    expect(rcode(refused)).toBe(5)
    expect(refused.readUInt16BE(6)).toBe(0)

    // Over TCP, length-prefixed.
    const msg = query(SITE, 1)
    const reply = await new Promise<Buffer>((resolve) => {
      const socket = net.connect(gate.ports.dns, '127.0.0.1', () => {
        socket.write(Buffer.concat([Buffer.from([0, msg.length]), msg]))
      })
      socket.on('data', (chunk: Buffer) => {
        socket.destroy()
        resolve(chunk.subarray(2))
      })
    })
    expect([...reply.subarray(reply.length - 4)]).toEqual([100, 64, 0, 9])
  })
})
