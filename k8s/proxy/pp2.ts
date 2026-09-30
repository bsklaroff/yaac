/**
 * PROXY protocol v2 parsing for the proxy's transparent listeners. netd's
 * Envoy prepends a PP2 header carrying the source pod IP to every redirected
 * connection; the proxy maps that IP to a workspace (see pod-watch.ts).
 *
 * Wire format: haproxy PROXY protocol spec §2.2. Accepts the AF_INET shape
 * Envoy sends, and AF_UNSPEC (TLVs only). Anything malformed is `invalid`,
 * so the listener fails closed.
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
 * `invalid` as soon as it cannot be one (e.g. a bare TLS ClientHello), and
 * `ok` once the whole header is present. Never throws.
 */
export function parsePp2Header(buf: Buffer): Pp2ParseResult {
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

