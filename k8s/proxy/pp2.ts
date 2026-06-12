/**
 * PROXY protocol v2 parsing + the yaac session-identity TLV, for the
 * proxy's transparent listeners. The per-pod yaac-relay (k8s/relay,
 * Go) prepends a PP2 header to every redirected connection carrying
 * `<sessionId>:<token>` in a custom TLV; the proxy parses it here,
 * verifies the token, and only then proceeds to the existing SNI / Host
 * handling. Zero deps and no side effects, so it is unit-testable by
 * import — mirrors transparent.ts.
 *
 * Wire format: haproxy PROXY protocol spec §2.2 (binary). We only emit /
 * accept the AF_INET + STREAM shape the relay produces; AF_UNSPEC (no
 * addresses, TLVs only) parses too. Everything malformed maps to
 * `invalid` so the listener fails closed.
 */

import crypto from 'node:crypto'

/** 12-byte v2 signature. */
const PP2_SIGNATURE = Buffer.from([
  0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
])

/** TLV type carrying "<sessionId>:<token>" (experimental range 0xE0–0xEF). */
export const PP2_TLV_YAAC_IDENTITY = 0xe0

/** Cap on the variable-length section, defense against a hostile length. */
const PP2_MAX_REMAINING = 1024

export type Pp2ParseResult =
  | { kind: 'need-more' }
  | { kind: 'invalid' }
  | {
      kind: 'ok'
      /** Bytes the header occupies; the caller unshifts everything after. */
      bytesConsumed: number
      srcIp: string | null
      dstIp: string | null
      srcPort: number | null
      dstPort: number | null
      tlvs: Map<number, Buffer>
    }

/**
 * Incrementally parse a PP2 header from the start of a buffered stream.
 * Returns `need-more` while the buffer is a valid prefix of a header,
 * `invalid` the moment it cannot be one (so a plain TLS ClientHello or
 * any non-relay client fails closed), `ok` with the consumed length once
 * the whole header is present. Never throws.
 */
export function parsePp2Header(buf: Buffer): Pp2ParseResult {
  // Signature: as soon as a byte diverges it is not PP2.
  const sigLen = Math.min(buf.length, PP2_SIGNATURE.length)
  if (!buf.subarray(0, sigLen).equals(PP2_SIGNATURE.subarray(0, sigLen))) {
    return { kind: 'invalid' }
  }
  if (buf.length < 16) return { kind: 'need-more' }

  const verCmd = buf[12]
  if ((verCmd & 0xf0) !== 0x20) return { kind: 'invalid' } // not version 2
  const command = verCmd & 0x0f
  if (command !== 0x00 && command !== 0x01) return { kind: 'invalid' }

  const family = buf[13] >> 4 // 0 UNSPEC, 1 AF_INET, 2 AF_INET6
  const remLen = buf.readUInt16BE(14)
  if (remLen > PP2_MAX_REMAINING) return { kind: 'invalid' }

  const total = 16 + remLen
  if (buf.length < total) return { kind: 'need-more' }

  let addrLen: number
  if (family === 1) addrLen = 12
  else if (family === 2) addrLen = 36
  else addrLen = 0 // UNSPEC and anything else: no address block, TLVs only
  if (remLen < addrLen) return { kind: 'invalid' }

  let off = 16
  let srcIp: string | null = null
  let dstIp: string | null = null
  let srcPort: number | null = null
  let dstPort: number | null = null
  if (family === 1) {
    srcIp = `${buf[off]}.${buf[off + 1]}.${buf[off + 2]}.${buf[off + 3]}`
    dstIp = `${buf[off + 4]}.${buf[off + 5]}.${buf[off + 6]}.${buf[off + 7]}`
    srcPort = buf.readUInt16BE(off + 8)
    dstPort = buf.readUInt16BE(off + 10)
  }
  off += addrLen

  const tlvs = new Map<number, Buffer>()
  while (off + 3 <= total) {
    const type = buf[off]
    const len = buf.readUInt16BE(off + 1)
    off += 3
    if (off + len > total) return { kind: 'invalid' }
    tlvs.set(type, buf.subarray(off, off + len))
    off += len
  }
  if (off !== total) return { kind: 'invalid' } // trailing partial TLV

  return { kind: 'ok', bytesConsumed: total, srcIp, dstIp, srcPort, dstPort, tlvs }
}

/**
 * Extract `{sessionId, token}` from the yaac identity TLV, or null when
 * absent / malformed. The value is `<sessionId>:<token>`; the token is hex
 * so it carries no colon, making the first colon an unambiguous split.
 */
export function identityFromPp2(
  tlvs: Map<number, Buffer>,
): { sessionId: string; token: string } | null {
  const value = tlvs.get(PP2_TLV_YAAC_IDENTITY)
  if (!value) return null
  const str = value.toString('utf8')
  const colon = str.indexOf(':')
  if (colon <= 0 || colon === str.length - 1) return null
  return { sessionId: str.slice(0, colon), token: str.slice(colon + 1) }
}

/**
 * The per-session relay credential: HMAC-SHA256(proxyAuthSecret,
 * "relay:" + sessionId), hex. The daemon computes the same value and
 * injects it into the relay container; the proxy recomputes and verifies
 * it per connection, so no token is ever stored or distributed and it
 * survives proxy pod replacement. Keep the formula in sync with
 * proxyClient.relayToken (src/lib/container/proxy-client.ts) — the proxy
 * cannot import from src/.
 */
export function relayTokenFor(secret: string, sessionId: string): string {
  return crypto.createHmac('sha256', secret).update(`relay:${sessionId}`).digest('hex')
}

/** Timing-safe check that `token` is the expected relay credential. */
export function verifyRelayToken(secret: string, sessionId: string, token: string): boolean {
  const expected = relayTokenFor(secret, sessionId)
  if (token.length !== expected.length) return false
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))
}
