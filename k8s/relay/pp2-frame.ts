/**
 * PROXY protocol v2 framing for the yaac relay — the sole producer of the
 * header the proxy's pp2.ts parses. Pure (no deps, no side effects) so the
 * relay imports it and the proxy's parser test imports it to verify real
 * producer bytes round-trip through the real parser. Kept in the relay's
 * build context (k8s/relay/) so the relay image can COPY it; the proxy
 * only ever parses, so it needs no builder.
 *
 * Wire format: haproxy PROXY protocol spec §2.2 (binary), AF_INET +
 * STREAM. Keep the signature + TLV type in sync with k8s/proxy/pp2.ts.
 */

/** 12-byte v2 signature. */
const PP2_SIGNATURE = Buffer.from([
  0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
])

/** TLV type carrying "<sessionId>:<token>" (experimental range 0xE0–0xEF). */
export const PP2_TLV_YAAC_IDENTITY = 0xe0

/**
 * Build a PP2 header for an IPv4/STREAM connection carrying the identity
 * TLV. Addresses are informational (the proxy routes on SNI/Host and
 * identifies on the TLV), so the relay passes only the original
 * destination port for logging and leaves the IPs zero.
 */
export function buildPp2Header(opts: {
  srcIp?: string
  srcPort?: number
  dstIp?: string
  dstPort?: number
  identity: string
}): Buffer {
  const ipv4 = (s: string | undefined): Buffer => {
    const parts = (s ?? '0.0.0.0').split('.').map((n) => parseInt(n, 10))
    if (parts.length !== 4 || parts.some((n) => !(n >= 0 && n <= 255))) {
      return Buffer.from([0, 0, 0, 0])
    }
    return Buffer.from(parts)
  }

  const identity = Buffer.from(opts.identity, 'utf8')
  const tlv = Buffer.alloc(3 + identity.length)
  tlv[0] = PP2_TLV_YAAC_IDENTITY
  tlv.writeUInt16BE(identity.length, 1)
  identity.copy(tlv, 3)

  const addr = Buffer.alloc(12)
  ipv4(opts.srcIp).copy(addr, 0)
  ipv4(opts.dstIp).copy(addr, 4)
  addr.writeUInt16BE((opts.srcPort ?? 0) & 0xffff, 8)
  addr.writeUInt16BE((opts.dstPort ?? 0) & 0xffff, 10)

  const rem = Buffer.concat([addr, tlv])
  const hdr = Buffer.alloc(16 + rem.length)
  PP2_SIGNATURE.copy(hdr, 0)
  hdr[12] = 0x21 // v2 + PROXY
  hdr[13] = 0x11 // AF_INET + STREAM
  hdr.writeUInt16BE(rem.length, 14)
  rem.copy(hdr, 16)
  return hdr
}
