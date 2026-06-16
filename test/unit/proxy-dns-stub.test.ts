import { describe, it, expect } from 'vitest'
import { parseDnsQuery, buildDnsResponse } from '@proxy/dns-stub'

// One question for "a.example" IN/<qtype>, no EDNS.
function query(qtype: number, id = 0x1234): Buffer {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(id, 0)
  header.writeUInt16BE(0x0100, 2) // RD set
  header.writeUInt16BE(1, 4) // QDCOUNT
  const qname = Buffer.concat([
    Buffer.from([1]), Buffer.from('a'),
    Buffer.from([7]), Buffer.from('example'),
    Buffer.from([0]),
  ])
  const tail = Buffer.alloc(4)
  tail.writeUInt16BE(qtype, 0)
  tail.writeUInt16BE(1, 2) // IN
  return Buffer.concat([header, qname, tail])
}

describe('parseDnsQuery', () => {
  it('parses a single-question A query', () => {
    const q = parseDnsQuery(query(1))
    expect(q).not.toBeNull()
    expect(q?.qtype).toBe(1)
    expect(q?.qclass).toBe(1)
    expect(q?.id).toBe(0x1234)
  })

  it('rejects responses (QR=1), short packets, and multi-question packets', () => {
    const resp = query(1)
    resp.writeUInt16BE(0x8000, 2) // QR=1
    expect(parseDnsQuery(resp)).toBeNull()
    expect(parseDnsQuery(Buffer.alloc(5))).toBeNull()
    const multi = query(1)
    multi.writeUInt16BE(2, 4) // QDCOUNT=2
    expect(parseDnsQuery(multi)).toBeNull()
  })
})

describe('buildDnsResponse', () => {
  it('answers an A query with the fixed dummy IP', () => {
    const q = parseDnsQuery(query(1))!
    const resp = buildDnsResponse(q, '198.18.0.1')
    expect(resp.readUInt16BE(0)).toBe(0x1234) // echoed id
    expect(resp.readUInt16BE(2) & 0x8000).toBe(0x8000) // QR set
    expect(resp.readUInt16BE(2) & 0x0200).toBe(0) // TC never set
    expect(resp.readUInt16BE(6)).toBe(1) // one answer
    // RDATA is the dummy IP (last 4 bytes).
    expect(Array.from(resp.subarray(resp.length - 4))).toEqual([198, 18, 0, 1])
  })

  it('returns an empty NOERROR (not NXDOMAIN) for non-A queries (e.g. AAAA)', () => {
    const q = parseDnsQuery(query(28))! // AAAA
    const resp = buildDnsResponse(q, '198.18.0.1')
    expect(resp.readUInt16BE(6)).toBe(0) // no answers
    expect(resp.readUInt16BE(2) & 0x000f).toBe(0) // RCODE 0 (NOERROR)
  })
})
