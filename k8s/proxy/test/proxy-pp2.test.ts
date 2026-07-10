import { describe, it, expect } from 'vitest'
import { parsePp2Header } from 'yaac-proxy-sidecar/pp2'

const PP2_SIG = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a])

function be16(n: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16BE(n)
  return b
}

/** The AF_INET / STREAM PROXY-protocol-v2 header Cilium's Envoy stamps. */
function afInet(
  srcIp = '10.244.0.5', srcPort = 54321, dstIp = '1.2.3.4', dstPort = 443,
): Buffer {
  const addr = Buffer.concat([
    Buffer.from(srcIp.split('.').map(Number)),
    Buffer.from(dstIp.split('.').map(Number)),
    be16(srcPort), be16(dstPort),
  ])
  return Buffer.concat([PP2_SIG, Buffer.from([0x21, 0x11]), be16(addr.length), addr])
}

describe('parsePp2Header', () => {
  it('round-trips an AF_INET header: source/destination addresses and ports', () => {
    const res = parsePp2Header(afInet())
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') return
    expect(res.srcIp).toBe('10.244.0.5')
    expect(res.dstIp).toBe('1.2.3.4')
    expect(res.srcPort).toBe(54321)
    expect(res.dstPort).toBe(443)
    expect(res.bytesConsumed).toBe(afInet().length)
    expect(res.tlvs.size).toBe(0)
  })

  it('consumes exactly the header, leaving trailing payload for the caller', () => {
    const payload = Buffer.from('subsequent-clienthello-bytes')
    const combined = Buffer.concat([afInet(), payload])
    const res = parsePp2Header(combined)
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') return
    expect(combined.subarray(res.bytesConsumed)).toEqual(payload)
  })

  it('returns need-more for every truncated prefix of a valid header', () => {
    const h = afInet()
    for (const len of [0, 1, 11, 12, 15, 16, h.length - 1]) {
      expect(parsePp2Header(h.subarray(0, len)), `len ${len}`).toEqual({ kind: 'need-more' })
    }
  })

  it('fails closed (invalid) on a TLS ClientHello — the key fail-closed case', () => {
    // First byte of a TLS record is 0x16, which diverges from the PP2
    // signature immediately, so a pod sending raw TLS gets no conversation.
    expect(parsePp2Header(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05])))
      .toEqual({ kind: 'invalid' })
  })

  it('fails closed on a plain HTTP request and on random bytes', () => {
    expect(parsePp2Header(Buffer.from('GET / HTTP/1.1\r\n'))).toEqual({ kind: 'invalid' })
    expect(parsePp2Header(Buffer.from([0xde, 0xad, 0xbe, 0xef]))).toEqual({ kind: 'invalid' })
  })

  it('fails closed on a correct signature but wrong version', () => {
    const bad = Buffer.from(afInet())
    bad[12] = 0x31 // version 3
    expect(parsePp2Header(bad)).toEqual({ kind: 'invalid' })
  })

  it('fails closed on a TLV that overruns the declared length', () => {
    // Address block (12B) + one TLV header claiming a 200-byte value but
    // only 3 bytes of value present.
    const addr = Buffer.alloc(12)
    const tlv = Buffer.concat([Buffer.from([0x02]), be16(200), Buffer.from('abc')])
    const rem = Buffer.concat([addr, tlv])
    const hdr = Buffer.concat([PP2_SIG, Buffer.from([0x21, 0x11]), be16(rem.length), rem])
    expect(parsePp2Header(hdr)).toEqual({ kind: 'invalid' })
  })

  it('rejects an oversized declared remaining length without buffering it', () => {
    const hdr = Buffer.concat([PP2_SIG, Buffer.from([0x21, 0x11, 0xff, 0xff])])
    expect(parsePp2Header(hdr)).toEqual({ kind: 'invalid' })
  })

  it('parses an AF_UNSPEC header (no address block) with a null source IP', () => {
    const hdr = Buffer.concat([PP2_SIG, Buffer.from([0x21, 0x00]), be16(0)])
    const res = parsePp2Header(hdr)
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') return
    expect(res.srcIp).toBeNull()
  })
})
