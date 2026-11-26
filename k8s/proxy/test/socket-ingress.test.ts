import { describe, it, expect, afterEach } from 'vitest'
import net from 'node:net'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { handleSocketIngress, type IngressKind } from 'yaac-proxy-sidecar/socket-ingress'

/**
 * The proxy's socket ingress port over real loopback: the relay's header is
 * accepted only with the proxy auth secret and a registered id, and its
 * destination picks the handler. The header bytes are the ones the relay's
 * Go test writes (k8s/mountd/internal/pp2), so the two ends agree.
 */

const SIG = '0d0a0d0a000d0a515549540a'
/** src 127.0.0.1:40000, dst 140.82.112.3:443, TLVs 0xE0 "ws-1" and 0xE1 "s3cret". */
const RELAY_HEADER = `${SIG}2111001c7f0000018c5270039c4001bbe0000477732d31e10006733363726574`

function header(dst: string, dstPort: number, tlvs: Array<[number, string]>): Buffer {
  const t = Buffer.concat(tlvs.map(([type, value]) => {
    const v = Buffer.from(value)
    const h = Buffer.alloc(3)
    h[0] = type
    h.writeUInt16BE(v.length, 1)
    return Buffer.concat([h, v])
  }))
  const addr = Buffer.alloc(12)
  Buffer.from([127, 0, 0, 1]).copy(addr, 0)
  Buffer.from(dst.split('.').map(Number)).copy(addr, 4)
  addr.writeUInt16BE(40000, 8)
  addr.writeUInt16BE(dstPort, 10)
  const len = Buffer.alloc(2)
  len.writeUInt16BE(12 + t.length)
  return Buffer.concat([Buffer.from(`${SIG}2111`, 'hex'), len, addr, t])
}

const servers: net.Server[] = []
afterEach(() => { for (const s of servers.splice(0)) s.close() })

interface Handed { kind: IngressKind; id: string; bytes: string }

/** A listener running handleSocketIngress; resolves what a handler got, or
 *  'closed' when the socket was destroyed. */
async function ingress(registered: string[]): Promise<{ port: number; next: () => Promise<Handed | 'closed'> }> {
  const results: Array<(r: Handed | 'closed') => void> = []
  const queued: Array<Handed | 'closed'> = []
  const settle = (r: Handed | 'closed'): void => {
    const waiter = results.shift()
    if (waiter) waiter(r)
    else queued.push(r)
  }
  const handler = (kind: IngressKind) => (socket: net.Socket, id: string, leftover: Buffer): void => {
    let bytes = leftover.toString()
    socket.on('data', (d: Buffer) => { bytes += d.toString() })
    socket.on('end', () => { settle({ kind, id, bytes }); socket.end() })
  }
  const server = net.createServer((socket) => {
    socket.on('close', () => { if (!socket.readableEnded) settle('closed') })
    handleSocketIngress(socket, {
      secret: 's3cret',
      registered: (id) => Promise.resolve(registered.includes(id)),
      handlers: { tls: handler('tls'), tunnel: handler('tunnel'), http: handler('http') },
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  servers.push(server)
  return {
    port: (server.address() as AddressInfo).port,
    next: () => {
      const r = queued.shift()
      return r !== undefined ? Promise.resolve(r) : new Promise((resolve) => results.push(resolve))
    },
  }
}

async function send(port: number, ...chunks: Buffer[]): Promise<void> {
  const c = net.connect(port, '127.0.0.1')
  await once(c, 'connect')
  for (const chunk of chunks) c.write(chunk)
  c.end()
  c.on('error', () => {})
}

describe('handleSocketIngress', () => {
  it('hands a connection to the handler its destination picks, with the id and every byte after the header', async () => {
    const { port, next } = await ingress(['ws-1', 'b-2'])
    // The relay's bytes, split mid-header, with the ClientHello pipelined.
    const relay = Buffer.from(RELAY_HEADER, 'hex')
    await send(port, relay.subarray(0, 20), Buffer.concat([relay.subarray(20), Buffer.from('hello')]))
    expect(await next()).toEqual({ kind: 'tls', id: 'ws-1', bytes: 'hello' })

    await send(port, header('198.18.0.2', 10259, [[0xe0, 'b-2'], [0xe1, 's3cret']]), Buffer.from('CONNECT x:22'))
    expect(await next()).toEqual({ kind: 'tunnel', id: 'b-2', bytes: 'CONNECT x:22' })

    // Any other address and port is plain HTTP, the sinkhole on 8080 and a
    // literal address on 80 alike; so is the sentinel on another port.
    for (const [dst, dstPort] of [['198.18.0.1', 8080], ['1.2.3.4', 80], ['198.18.0.2', 22]] as const) {
      await send(port, header(dst, dstPort, [[0xe0, 'ws-1'], [0xe1, 's3cret']]), Buffer.from('GET /'))
      expect(await next()).toEqual({ kind: 'http', id: 'ws-1', bytes: 'GET /' })
    }
  })

  it('refuses a header without the secret, without an id, or naming an unregistered id', async () => {
    const { port, next } = await ingress(['ws-1'])
    for (const tlvs of [
      [[0xe0, 'ws-1'], [0xe1, 'wrong!']],
      [[0xe0, 'ws-1']],
      [[0xe1, 's3cret']],
      [[0xe0, 'ws-9'], [0xe1, 's3cret']],
    ] as Array<Array<[number, string]>>) {
      await send(port, header('1.2.3.4', 443, tlvs), Buffer.from('hello'))
      expect(await next()).toBe('closed')
    }
    // Not a PROXY header at all: a sandbox's bytes with no relay in front.
    await send(port, Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n\r\n'))
    expect(await next()).toBe('closed')
  })
})
