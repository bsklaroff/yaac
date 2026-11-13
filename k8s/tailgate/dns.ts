/**
 * The site domain's nameserver. The tailnet's split DNS sends the zone to
 * this device, which answers A and AAAA for every name under it with its
 * own tailnet addresses, so each site resolves to this one tunnel and no
 * site needs a record anywhere. A name outside the zone is refused, so the
 * device is no resolver for anything else. A name under the zone that no
 * site has still resolves, and the router answers 404 for it.
 */
import dgram from 'node:dgram'
import net from 'node:net'

const QTYPE_A = 1
const QTYPE_AAAA = 28
const QCLASS_IN = 1
const RCODE_REFUSED = 5
const TTL_SECONDS = 60

interface Query {
  id: number
  rd: boolean
  qtype: number
  qclass: number
  name: string
  /** QNAME + QTYPE + QCLASS, echoed in the answer. */
  question: Buffer
}

/** One-question queries only; anything else is dropped. */
function parseQuery(buf: Buffer): Query | null {
  if (buf.length < 12 || buf.readUInt16BE(2) & 0x8000 || buf.readUInt16BE(4) !== 1) return null
  let off = 12
  const labels: string[] = []
  for (;;) {
    const len = buf[off]
    if (len === undefined || len > 63 || off + 1 + len > buf.length) return null
    off += 1
    if (len === 0) break
    labels.push(buf.toString('latin1', off, off + len).toLowerCase())
    off += len
  }
  if (off + 4 > buf.length) return null
  return {
    id: buf.readUInt16BE(0),
    rd: (buf.readUInt16BE(2) & 0x0100) !== 0,
    qtype: buf.readUInt16BE(off),
    qclass: buf.readUInt16BE(off + 2),
    name: labels.join('.'),
    question: buf.subarray(12, off + 4),
  }
}

function ipBytes(ip: string): Buffer {
  if (net.isIPv4(ip)) return Buffer.from(ip.split('.').map(Number))
  const [head, tail = ''] = ip.split('::')
  const groups = (part: string): string[] => (part ? part.split(':') : [])
  const words = [...groups(head), ...Array<string>(8 - groups(head).length - groups(tail).length).fill('0'), ...groups(tail)]
  const out = Buffer.alloc(16)
  words.forEach((w, i) => out.writeUInt16BE(parseInt(w, 16), i * 2))
  return out
}

/** The answer to `buf`, or null to drop it. */
export function answerQuery(buf: Buffer, zone: string, addresses: string[]): Buffer | null {
  const q = parseQuery(buf)
  if (!q) return null
  const inZone = q.name === zone || q.name.endsWith(`.${zone}`)
  const records = inZone && q.name !== zone && q.qclass === QCLASS_IN
    ? addresses.filter((ip) => (q.qtype === QTYPE_A ? net.isIPv4(ip) : q.qtype === QTYPE_AAAA && net.isIPv6(ip)))
    : []
  const header = Buffer.alloc(12)
  header.writeUInt16BE(q.id, 0)
  // QR, AA for the zone, RD echoed, and REFUSED outside it.
  header.writeUInt16BE(0x8000 | (inZone ? 0x0400 : RCODE_REFUSED) | (q.rd ? 0x0100 : 0), 2)
  header.writeUInt16BE(1, 4)
  header.writeUInt16BE(records.length, 6)
  const answers = records.map((ip) => {
    const data = ipBytes(ip)
    const rr = Buffer.alloc(12)
    rr.writeUInt16BE(0xc00c, 0) // a pointer to the question's name
    rr.writeUInt16BE(q.qtype, 2)
    rr.writeUInt16BE(QCLASS_IN, 4)
    rr.writeUInt32BE(TTL_SECONDS, 6)
    rr.writeUInt16BE(data.length, 10)
    return Buffer.concat([rr, data])
  })
  return Buffer.concat([header, q.question, ...answers])
}

/** Serve DNS over UDP and TCP on `host:port`, answering from `addresses()`. */
export async function startDns(opts: {
  host: string
  port: number
  zone: string
  addresses: () => string[]
}): Promise<{ port: number; close: () => Promise<void> }> {
  const udp = dgram.createSocket(opts.host.includes(':') ? 'udp6' : 'udp4')
  udp.on('message', (msg, rinfo) => {
    const reply = answerQuery(msg, opts.zone, opts.addresses())
    if (reply) udp.send(reply, rinfo.port, rinfo.address)
  })
  await new Promise<void>((resolve) => udp.bind(opts.port, opts.host, resolve))
  const port = udp.address().port
  // Over TCP each message is prefixed with its length.
  const tcp = net.createServer((socket) => {
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      while (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
        const reply = answerQuery(buf.subarray(2, 2 + buf.readUInt16BE(0)), opts.zone, opts.addresses())
        buf = buf.subarray(2 + buf.readUInt16BE(0))
        if (!reply) continue
        const len = Buffer.alloc(2)
        len.writeUInt16BE(reply.length)
        socket.write(Buffer.concat([len, reply]))
      }
    })
    socket.on('error', () => socket.destroy())
  })
  await new Promise<void>((resolve) => tcp.listen(port, opts.host, resolve))
  return {
    port,
    close: async () => {
      await new Promise<void>((resolve) => udp.close(() => resolve()))
      await new Promise<void>((resolve) => tcp.close(() => resolve()))
    },
  }
}
