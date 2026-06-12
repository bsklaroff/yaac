import { describe, it, expect } from 'vitest'
import {
  PP2_TLV_YAAC_IDENTITY,
  identityFromPp2,
  parsePp2Header,
  relayTokenFor,
  verifyRelayToken,
} from '@proxy/pp2'
// The relay is the real PP2 producer; test the proxy's parser against it.
import { buildPp2Header } from '@relay/pp2-frame'

const SECRET = 'test-proxy-secret'
const SID = 'abcd-1234'

function header(identity = `${SID}:${relayTokenFor(SECRET, SID)}`): Buffer {
  return buildPp2Header({ srcIp: '10.244.0.5', srcPort: 54321, dstIp: '1.2.3.4', dstPort: 443, identity })
}

describe('parsePp2Header', () => {
  it('round-trips a built header: addresses, ports, and the identity TLV', () => {
    const res = parsePp2Header(header())
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') return
    expect(res.srcIp).toBe('10.244.0.5')
    expect(res.dstIp).toBe('1.2.3.4')
    expect(res.srcPort).toBe(54321)
    expect(res.dstPort).toBe(443)
    expect(res.bytesConsumed).toBe(header().length)
    expect(res.tlvs.get(PP2_TLV_YAAC_IDENTITY)?.toString('utf8')).toBe(`${SID}:${relayTokenFor(SECRET, SID)}`)
  })

  it('consumes exactly the header, leaving trailing payload for the caller', () => {
    const payload = Buffer.from('subsequent-clienthello-bytes')
    const combined = Buffer.concat([header(), payload])
    const res = parsePp2Header(combined)
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') return
    expect(combined.subarray(res.bytesConsumed)).toEqual(payload)
  })

  it('returns need-more for every truncated prefix of a valid header', () => {
    const h = header()
    for (const len of [0, 1, 11, 12, 15, 16, h.length - 1]) {
      expect(parsePp2Header(h.subarray(0, len)), `len ${len}`).toEqual({ kind: 'need-more' })
    }
  })

  it('fails closed (invalid) on a TLS ClientHello — the key fail-closed case', () => {
    // First byte of a TLS record is 0x16, which diverges from the PP2
    // signature immediately.
    expect(parsePp2Header(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05])))
      .toEqual({ kind: 'invalid' })
  })

  it('fails closed on a plain HTTP request and on random bytes', () => {
    expect(parsePp2Header(Buffer.from('GET / HTTP/1.1\r\n'))).toEqual({ kind: 'invalid' })
    expect(parsePp2Header(Buffer.from([0xde, 0xad, 0xbe, 0xef]))).toEqual({ kind: 'invalid' })
  })

  it('fails closed on a correct signature but wrong version', () => {
    const h = header()
    const bad = Buffer.from(h)
    bad[12] = 0x31 // version 3
    expect(parsePp2Header(bad)).toEqual({ kind: 'invalid' })
  })

  it('fails closed on a TLV that overruns the declared length', () => {
    // Address block (12B) + one TLV header claiming a 200-byte value but
    // only 3 bytes of value present.
    const sig = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a])
    const addr = Buffer.alloc(12)
    const tlv = Buffer.concat([Buffer.from([PP2_TLV_YAAC_IDENTITY]), be16(200), Buffer.from('abc')])
    const rem = Buffer.concat([addr, tlv])
    const hdr = Buffer.concat([sig, Buffer.from([0x21, 0x11]), be16(rem.length), rem])
    expect(parsePp2Header(hdr)).toEqual({ kind: 'invalid' })
  })

  it('rejects an oversized declared remaining length without buffering it', () => {
    const sig = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a])
    const hdr = Buffer.concat([sig, Buffer.from([0x21, 0x11, 0xff, 0xff])])
    expect(parsePp2Header(hdr)).toEqual({ kind: 'invalid' })
  })

  it('parses an AF_UNSPEC header (no address block, TLVs only)', () => {
    const identity = Buffer.from('s:t')
    const tlv = Buffer.concat([Buffer.from([PP2_TLV_YAAC_IDENTITY]), be16(identity.length), identity])
    const sig = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a])
    const hdr = Buffer.concat([sig, Buffer.from([0x21, 0x00]), be16(tlv.length), tlv])
    const res = parsePp2Header(hdr)
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') return
    expect(res.srcIp).toBeNull()
    expect(res.tlvs.get(PP2_TLV_YAAC_IDENTITY)?.toString('utf8')).toBe('s:t')
  })
})

function be16(n: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16BE(n)
  return b
}

describe('identityFromPp2', () => {
  it('splits "<sessionId>:<token>" on the first colon', () => {
    const res = parsePp2Header(header())
    if (res.kind !== 'ok') throw new Error('parse failed')
    expect(identityFromPp2(res.tlvs)).toEqual({ sessionId: SID, token: relayTokenFor(SECRET, SID) })
  })

  it('returns null when the identity TLV is absent', () => {
    expect(identityFromPp2(new Map())).toBeNull()
  })

  it('returns null for malformed values (no colon, empty side)', () => {
    for (const v of ['no-colon', ':token', 'sid:']) {
      expect(identityFromPp2(new Map([[PP2_TLV_YAAC_IDENTITY, Buffer.from(v)]]))).toBeNull()
    }
  })
})

describe('relayTokenFor / verifyRelayToken', () => {
  it('verifies a token the daemon would compute for the same session', () => {
    const token = relayTokenFor(SECRET, SID)
    expect(verifyRelayToken(SECRET, SID, token)).toBe(true)
  })

  it('rejects a token bound to a different session id', () => {
    const token = relayTokenFor(SECRET, 'other-session')
    expect(verifyRelayToken(SECRET, SID, token)).toBe(false)
  })

  it('rejects a token computed under a different secret', () => {
    const token = relayTokenFor('wrong-secret', SID)
    expect(verifyRelayToken(SECRET, SID, token)).toBe(false)
  })

  it('rejects empty / wrong-length tokens without throwing', () => {
    expect(verifyRelayToken(SECRET, SID, '')).toBe(false)
    expect(verifyRelayToken(SECRET, SID, 'deadbeef')).toBe(false)
  })

  it('is deterministic and hex (so it never collides with the colon separator)', () => {
    expect(relayTokenFor(SECRET, SID)).toMatch(/^[0-9a-f]{64}$/)
    expect(relayTokenFor(SECRET, SID)).toBe(relayTokenFor(SECRET, SID))
  })
})

describe('end-to-end identity gate', () => {
  it('a header built with a valid token verifies after parse', () => {
    const token = relayTokenFor(SECRET, SID)
    const res = parsePp2Header(buildPp2Header({ identity: `${SID}:${token}` }))
    if (res.kind !== 'ok') throw new Error('parse failed')
    const id = identityFromPp2(res.tlvs)
    expect(id).not.toBeNull()
    expect(verifyRelayToken(SECRET, id!.sessionId, id!.token)).toBe(true)
  })

  it('a header carrying a forged token parses but fails verification', () => {
    const res = parsePp2Header(buildPp2Header({ identity: `${SID}:${'0'.repeat(64)}` }))
    if (res.kind !== 'ok') throw new Error('parse failed')
    const id = identityFromPp2(res.tlvs)!
    expect(verifyRelayToken(SECRET, id.sessionId, id.token)).toBe(false)
  })
})
