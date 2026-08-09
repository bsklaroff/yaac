import { describe, it, expect } from 'vitest'
import net from 'node:net'
import tls from 'node:tls'
import {
  isInternalUpstream,
  normalizeRemoteAddr,
  parseSniFromClientHello,
  peekClientHelloSni,
  splitHostHeader,
} from 'yaac-proxy-sidecar/transparent'

function u16(n: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16BE(n)
  return b
}

function u24(n: number): Buffer {
  return Buffer.from([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff])
}

/** Minimal synthetic ClientHello, optionally with a server_name extension. */
function buildClientHello(serverName?: string): Buffer {
  const random = Buffer.alloc(32, 1)
  const worktreeId = Buffer.from([0])
  const cipherSuites = Buffer.concat([u16(2), Buffer.from([0x13, 0x01])])
  const compression = Buffer.from([1, 0])
  let extensions = Buffer.alloc(0)
  if (serverName !== undefined) {
    const name = Buffer.from(serverName)
    const entry = Buffer.concat([Buffer.from([0]), u16(name.length), name])
    const list = Buffer.concat([u16(entry.length), entry])
    extensions = Buffer.concat([u16(0x0000), u16(list.length), list])
  }
  const body = Buffer.concat([
    Buffer.from([3, 3]), random, worktreeId, cipherSuites, compression,
    u16(extensions.length), extensions,
  ])
  const handshake = Buffer.concat([Buffer.from([1]), u24(body.length), body])
  return Buffer.concat([Buffer.from([0x16, 3, 1]), u16(handshake.length), handshake])
}

/**
 * Capture the raw ClientHello Node's real TLS stack sends — the listener
 * must parse what actual clients produce, not just our synthetic bytes.
 * Loopback only; no network.
 */
function captureRealClientHello(servername: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer((sock) => {
      sock.once('data', (chunk: Buffer) => {
        sock.destroy()
        srv.close()
        resolve(chunk)
      })
    })
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo
      const client = tls.connect({ host: '127.0.0.1', port, servername, rejectUnauthorized: false })
      client.on('error', () => { /* server hangs up mid-handshake — expected */ })
    })
  })
}

describe('peekClientHelloSni', () => {
  it('finds the SNI in a synthetic ClientHello', () => {
    expect(peekClientHelloSni(buildClientHello('api.anthropic.com')))
      .toEqual({ kind: 'found', serverName: 'api.anthropic.com' })
  })

  it('finds the SNI in a real ClientHello from node tls', async () => {
    const hello = await captureRealClientHello('example.test')
    expect(peekClientHelloSni(hello)).toEqual({ kind: 'found', serverName: 'example.test' })
  })

  it('lowercases the server name', () => {
    expect(peekClientHelloSni(buildClientHello('API.Anthropic.COM')))
      .toEqual({ kind: 'found', serverName: 'api.anthropic.com' })
  })

  it('returns need-more for an empty buffer and for truncated prefixes', () => {
    const hello = buildClientHello('example.com')
    expect(peekClientHelloSni(Buffer.alloc(0))).toEqual({ kind: 'need-more' })
    for (const len of [1, 4, 5, 20, hello.length - 1]) {
      expect(peekClientHelloSni(hello.subarray(0, len))).toEqual({ kind: 'need-more' })
    }
  })

  it('reassembles a ClientHello fragmented across two records', () => {
    const whole = buildClientHello('split.example.com')
    const handshake = whole.subarray(5)
    const mid = Math.floor(handshake.length / 2)
    const rec = (frag: Buffer): Buffer =>
      Buffer.concat([Buffer.from([0x16, 3, 1]), u16(frag.length), frag])
    const fragmented = Buffer.concat([rec(handshake.subarray(0, mid)), rec(handshake.subarray(mid))])

    expect(peekClientHelloSni(fragmented.subarray(0, mid + 5))).toEqual({ kind: 'need-more' })
    expect(peekClientHelloSni(fragmented))
      .toEqual({ kind: 'found', serverName: 'split.example.com' })
  })

  it('fails closed on non-TLS bytes', () => {
    expect(peekClientHelloSni(Buffer.from('GET / HTTP/1.1\r\n'))).toEqual({ kind: 'none' })
  })

  it('fails closed on a complete ClientHello without SNI', () => {
    expect(peekClientHelloSni(buildClientHello())).toEqual({ kind: 'none' })
  })

  it('fails closed on a non-ClientHello handshake message', () => {
    const hello = buildClientHello('example.com')
    const mutated = Buffer.from(hello)
    mutated[5] = 0x02 // ServerHello
    expect(peekClientHelloSni(mutated)).toEqual({ kind: 'none' })
  })

  it('fails closed on impossible record lengths', () => {
    // length 0
    expect(peekClientHelloSni(Buffer.from([0x16, 3, 1, 0, 0, 0])))
      .toEqual({ kind: 'none' })
    // length > 2^14
    expect(peekClientHelloSni(Buffer.from([0x16, 3, 1, 0x7f, 0xff, 1])))
      .toEqual({ kind: 'none' })
  })
})

describe('parseSniFromClientHello', () => {
  it('returns the hostname for a complete hello with SNI', () => {
    expect(parseSniFromClientHello(buildClientHello('github.com'))).toBe('github.com')
  })

  it('returns null for non-TLS bytes, missing SNI, and incomplete hellos', () => {
    expect(parseSniFromClientHello(Buffer.from('SSH-2.0-OpenSSH\r\n'))).toBeNull()
    expect(parseSniFromClientHello(buildClientHello())).toBeNull()
    expect(parseSniFromClientHello(buildClientHello('x.test').subarray(0, 10))).toBeNull()
  })
})

describe('normalizeRemoteAddr', () => {
  it('unwraps IPv4-mapped IPv6 addresses', () => {
    expect(normalizeRemoteAddr('::ffff:10.244.0.12')).toBe('10.244.0.12')
    expect(normalizeRemoteAddr('::FFFF:192.168.0.1')).toBe('192.168.0.1')
  })

  it('passes plain addresses through', () => {
    expect(normalizeRemoteAddr('10.244.0.12')).toBe('10.244.0.12')
    expect(normalizeRemoteAddr('::1')).toBe('::1')
  })

  it('maps absent addresses to null (fail closed)', () => {
    expect(normalizeRemoteAddr(undefined)).toBeNull()
    expect(normalizeRemoteAddr(null)).toBeNull()
    expect(normalizeRemoteAddr('')).toBeNull()
  })
})

describe('isInternalUpstream', () => {
  it.each([
    'localhost', 'foo.localhost', '127.0.0.1', '127.1.2.3', '0.0.0.0',
    '10.96.227.19', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.1.1', '100.64.0.1', '100.127.255.255',
    '::1', '::', '[::1]', 'fc00::1', 'fd12::3', 'fe80::1', '::ffff:10.0.0.1',
    'yaac-proxy.yaac.svc', 'echo.yaac-test.svc.cluster.local', 'foo.cluster.local',
  ])('treats %s as internal', (host) => {
    expect(isInternalUpstream(host)).toBe(true)
  })

  it.each([
    'example.com', 'api.anthropic.com', 'github.com',
    '8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '169.255.0.1',
    '2606:4700::1111', 'svc.example.com',
  ])('treats %s as external', (host) => {
    expect(isInternalUpstream(host)).toBe(false)
  })
})

describe('splitHostHeader', () => {
  it('splits host:port and applies the default port when absent', () => {
    expect(splitHostHeader('example.com', 80)).toEqual({ hostname: 'example.com', port: 80 })
    expect(splitHostHeader('example.com:8080', 80)).toEqual({ hostname: 'example.com', port: 8080 })
  })

  it('lowercases the hostname', () => {
    expect(splitHostHeader('Example.COM', 80)).toEqual({ hostname: 'example.com', port: 80 })
  })

  it('handles bracketed IPv6 literals', () => {
    expect(splitHostHeader('[::1]', 80)).toEqual({ hostname: '::1', port: 80 })
    expect(splitHostHeader('[fd00::2]:8443', 80)).toEqual({ hostname: 'fd00::2', port: 8443 })
  })

  it('fails closed on malformed values', () => {
    expect(splitHostHeader('', 80)).toBeNull()
    expect(splitHostHeader('   ', 80)).toBeNull()
    expect(splitHostHeader(':8080', 80)).toBeNull()
    expect(splitHostHeader('host:notaport', 80)).toBeNull()
    expect(splitHostHeader('host:0', 80)).toBeNull()
    expect(splitHostHeader('host:70000', 80)).toBeNull()
    expect(splitHostHeader('fd00::1:443', 80)).toBeNull() // unbracketed IPv6
    expect(splitHostHeader('[::1', 80)).toBeNull()
  })
})
