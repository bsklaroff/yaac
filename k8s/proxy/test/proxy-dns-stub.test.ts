import { describe, it, expect } from 'vitest'
import { parseDnsQuery, buildDnsResponse, isInternalName } from 'yaac-proxy-sidecar/dns-stub'

// One question for `name` IN/<qtype>, no EDNS.
function query(qtype: number, name = 'a.example', id = 0x1234): Buffer {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(id, 0)
  header.writeUInt16BE(0x0100, 2) // RD set
  header.writeUInt16BE(1, 4) // QDCOUNT
  const qname = Buffer.concat([
    ...name.split('.').map((label) =>
      Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])),
    Buffer.from([0]),
  ])
  const tail = Buffer.alloc(4)
  tail.writeUInt16BE(qtype, 0)
  tail.writeUInt16BE(1, 2) // IN
  return Buffer.concat([header, qname, tail])
}

describe('parseDnsQuery', () => {
  it('parses a single-question A query and decodes the QNAME', () => {
    const q = parseDnsQuery(query(1))
    expect(q).not.toBeNull()
    expect(q?.qtype).toBe(1)
    expect(q?.qclass).toBe(1)
    expect(q?.id).toBe(0x1234)
    expect(q?.name).toBe('a.example')
  })

  it('lowercases the decoded QNAME', () => {
    const q = parseDnsQuery(query(1, 'YAAC-Reg-Foo.NS.svc'))
    expect(q?.name).toBe('yaac-reg-foo.ns.svc')
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

describe('isInternalName', () => {
  it('matches only Services in the install namespace, the ones workspaces dial directly', () => {
    for (const name of [
      'yaac-reg-foo.ns.svc.cluster.local',
      'yaac-npm-cache.ns.svc.cluster.local',
      'YAAC-Reg-Foo.NS.svc.cluster.local', // case-insensitive
      'yaac-reg-foo.ns.svc.cluster.local.', // trailing dot
    ]) expect(isInternalName(name, 'ns'), name).toBe(true)
  })

  it('sinkholes every other name, other cluster names included, so it goes through the proxy', () => {
    for (const name of [
      // Another namespace's Service, the API server, a pod record: the
      // proxy applies the allowlist and non-public guard to them.
      'internal-web.other.svc.cluster.local',
      'kubernetes.default.svc.cluster.local',
      '169-254-169-254.ns.pod.cluster.local',
      'foo.ns.cluster.local',
      'evil.ns.svc.cluster.local.attacker.example',
      'xns.svc.cluster.local',
      // Out of cluster DNS's zone, so CoreDNS would forward it upstream.
      'yaac-reg-foo.ns.svc',
      'api.anthropic.com',
    ]) expect(isInternalName(name, 'ns'), name).toBe(false)
  })
})

describe('buildDnsResponse', () => {
  it('answers an A query with the given IP', () => {
    const q = parseDnsQuery(query(1))!
    const resp = buildDnsResponse(q, '198.18.0.1')
    expect(resp.readUInt16BE(0)).toBe(0x1234) // echoed id
    expect(resp.readUInt16BE(2) & 0x8000).toBe(0x8000) // QR set
    expect(resp.readUInt16BE(2) & 0x0200).toBe(0) // TC never set
    expect(resp.readUInt16BE(6)).toBe(1) // one answer
    // RDATA is the IP (last 4 bytes).
    expect(Array.from(resp.subarray(resp.length - 4))).toEqual([198, 18, 0, 1])
  })

  it('answers an A query with a resolved ClusterIP', () => {
    const q = parseDnsQuery(query(1, 'yaac-reg-foo.ns.svc'))!
    const resp = buildDnsResponse(q, '10.96.42.7')
    expect(resp.readUInt16BE(6)).toBe(1)
    expect(Array.from(resp.subarray(resp.length - 4))).toEqual([10, 96, 42, 7])
  })

  it('returns an empty NOERROR (not NXDOMAIN) for non-A queries (e.g. AAAA)', () => {
    const q = parseDnsQuery(query(28))! // AAAA
    const resp = buildDnsResponse(q, '198.18.0.1')
    expect(resp.readUInt16BE(6)).toBe(0) // no answers
    expect(resp.readUInt16BE(2) & 0x000f).toBe(0) // RCODE 0 (NOERROR)
  })

  it('returns an empty NOERROR for an A query when ip is null (failed lookup)', () => {
    const q = parseDnsQuery(query(1, 'yaac-reg-foo.ns.svc'))!
    const resp = buildDnsResponse(q, null)
    expect(resp.readUInt16BE(6)).toBe(0) // no answers
    expect(resp.readUInt16BE(2) & 0x000f).toBe(0) // RCODE 0 (NOERROR)
  })
})
