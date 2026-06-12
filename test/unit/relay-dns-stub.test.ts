import { describe, it, expect } from 'vitest'
import {
  DNS_QCLASS_IN,
  DNS_QTYPE_A,
  buildDnsResponse,
  parseDnsQuery,
  type DnsQuery,
} from '@relay/dns-stub'

const DUMMY_IP = '198.18.0.1'
const QTYPE_AAAA = 28

/** Encode a QNAME as length-prefixed labels (the wire format). */
function encodeName(name: string): Buffer {
  const parts = name.split('.').map((label) => {
    const bytes = Buffer.from(label, 'ascii')
    return Buffer.concat([Buffer.from([bytes.length]), bytes])
  })
  return Buffer.concat([...parts, Buffer.from([0])])
}

/** Build a query packet the way a real resolver would. */
function buildQuery(opts: {
  id?: number
  name?: string
  qtype?: number
  qclass?: number
  rd?: boolean
  qr?: boolean
  qdcount?: number
} = {}): Buffer {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(opts.id ?? 0x1234, 0)
  header.writeUInt16BE((opts.qr ? 0x8000 : 0) | (opts.rd === false ? 0 : 0x0100), 2)
  header.writeUInt16BE(opts.qdcount ?? 1, 4)
  const question = Buffer.alloc(4)
  question.writeUInt16BE(opts.qtype ?? DNS_QTYPE_A, 0)
  question.writeUInt16BE(opts.qclass ?? DNS_QCLASS_IN, 2)
  return Buffer.concat([header, encodeName(opts.name ?? 'example.com'), question])
}

describe('parseDnsQuery', () => {
  it('parses a single-question A query: id, flags, qtype/qclass, raw question', () => {
    const buf = buildQuery({ id: 0xbeef, name: 'api.anthropic.com' })
    const q = parseDnsQuery(buf)
    expect(q).not.toBeNull()
    expect(q?.id).toBe(0xbeef)
    expect(q?.opcode).toBe(0)
    expect(q?.rd).toBe(true)
    expect(q?.qtype).toBe(DNS_QTYPE_A)
    expect(q?.qclass).toBe(DNS_QCLASS_IN)
    // The question section is everything after the header.
    expect(q?.question.equals(buf.subarray(12))).toBe(true)
  })

  it('rejects multi-question packets', () => {
    expect(parseDnsQuery(buildQuery({ qdcount: 2 }))).toBeNull()
    expect(parseDnsQuery(buildQuery({ qdcount: 0 }))).toBeNull()
  })

  it('rejects responses (QR=1) — the stub must never answer an answer', () => {
    expect(parseDnsQuery(buildQuery({ qr: true }))).toBeNull()
  })

  it('rejects truncated and malformed packets instead of throwing', () => {
    const full = buildQuery()
    expect(parseDnsQuery(Buffer.alloc(0))).toBeNull()
    expect(parseDnsQuery(full.subarray(0, 11))).toBeNull() // header cut short
    expect(parseDnsQuery(full.subarray(0, full.length - 2))).toBeNull() // qclass cut short
    // A name that never 0-terminates runs off the end of the packet.
    const unterminated = Buffer.concat([full.subarray(0, 12), Buffer.from([5, 97, 98])])
    expect(parseDnsQuery(unterminated)).toBeNull()
    // Compression pointers (len > 63) are malformed in a query's name.
    const pointer = Buffer.concat([
      full.subarray(0, 12), Buffer.from([0xc0, 0x0c]), Buffer.alloc(4),
    ])
    expect(parseDnsQuery(pointer)).toBeNull()
  })

  it('tolerates trailing bytes after the question (EDNS OPT records)', () => {
    const opt = Buffer.from([0, 0, 41, 16, 0, 0, 0, 0, 0, 0, 0]) // root + OPT RR
    const q = parseDnsQuery(Buffer.concat([buildQuery(), opt]))
    expect(q).not.toBeNull()
    // The echoed question excludes the trailing OPT.
    expect(q?.question.equals(buildQuery().subarray(12))).toBe(true)
  })
})

describe('buildDnsResponse', () => {
  const parse = (buf: Buffer): DnsQuery => {
    const q = parseDnsQuery(buf)
    if (!q) throw new Error('fixture query failed to parse')
    return q
  }

  it('answers an A query with a single dummy-IP record, echoing id and question', () => {
    const query = buildQuery({ id: 0x4242, name: 'blocked.example.com' })
    const res = buildDnsResponse(parse(query), DUMMY_IP)

    expect(res.readUInt16BE(0)).toBe(0x4242) // id echoed
    const flags = res.readUInt16BE(2)
    expect(flags & 0x8000).toBe(0x8000) // QR=1
    expect(flags & 0x0100).toBe(0x0100) // RD echoed
    expect(flags & 0x0080).toBe(0x0080) // RA set
    expect(flags & 0x000f).toBe(0) // NOERROR
    expect(res.readUInt16BE(4)).toBe(1) // QDCOUNT
    expect(res.readUInt16BE(6)).toBe(1) // ANCOUNT
    expect(res.readUInt16BE(8)).toBe(0) // NSCOUNT
    expect(res.readUInt16BE(10)).toBe(0) // ARCOUNT

    // Question echoed verbatim, then the answer RR.
    const question = query.subarray(12)
    expect(res.subarray(12, 12 + question.length).equals(question)).toBe(true)
    const rr = res.subarray(12 + question.length)
    expect(rr.readUInt16BE(0)).toBe(0xc00c) // name pointer to the QNAME
    expect(rr.readUInt16BE(2)).toBe(DNS_QTYPE_A)
    expect(rr.readUInt16BE(4)).toBe(DNS_QCLASS_IN)
    expect(rr.readUInt16BE(10)).toBe(4) // RDLENGTH
    expect([...rr.subarray(12, 16)]).toEqual([198, 18, 0, 1])
  })

  it('answers AAAA (and anything non-A) with an empty NOERROR, not NXDOMAIN', () => {
    const query = buildQuery({ qtype: QTYPE_AAAA })
    const res = buildDnsResponse(parse(query), DUMMY_IP)
    expect(res.readUInt16BE(6)).toBe(0) // ANCOUNT 0
    expect(res.readUInt16BE(2) & 0x000f).toBe(0) // RCODE NOERROR
    // Header + echoed question, nothing else (same size as the query).
    expect(res.length).toBe(query.length)

    const chaos = buildQuery({ qclass: 3 }) // A query, but class CH
    expect(buildDnsResponse(parse(chaos), DUMMY_IP).readUInt16BE(6)).toBe(0)
  })

  it('echoes RD=0 and never sets the truncation bit (no tcp/53 fallback)', () => {
    for (const qtype of [DNS_QTYPE_A, QTYPE_AAAA]) {
      const res = buildDnsResponse(parse(buildQuery({ qtype, rd: false })), DUMMY_IP)
      const flags = res.readUInt16BE(2)
      expect(flags & 0x0200).toBe(0) // TC never set
      expect(flags & 0x0100).toBe(0) // RD echoed as 0
    }
  })

  it('round-trips: its own response is rejected by parseDnsQuery (QR=1)', () => {
    const res = buildDnsResponse(parse(buildQuery()), DUMMY_IP)
    expect(parseDnsQuery(res)).toBeNull()
  })
})
