/**
 * PROXY protocol v2 parsing for the proxy's transparent listeners. netd's
 * node-local Envoy prepends a PP2 header to every redirected
 * connection carrying the real source pod IP (AF_INET); the proxy parses it
 * here, then resolves that IP to a worktree (see pod-watch.ts) before the
 * existing SNI / Host handling. Zero deps and no side effects, so it is
 * unit-testable by import — mirrors transparent.ts.
 *
 * Wire format: haproxy PROXY protocol spec §2.2 (binary). We accept the
 * AF_INET + STREAM shape Envoy produces; AF_UNSPEC (no addresses, TLVs only)
 * parses too. Everything malformed maps to `invalid` so the listener fails
 * closed.
 */

/** 12-byte v2 signature. */
const PP2_SIGNATURE = Buffer.from([
  0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
])

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

