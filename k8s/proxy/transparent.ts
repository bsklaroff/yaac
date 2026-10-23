/**
 * Pure helpers for the proxy's transparent egress listeners.
 */

/**
 * Result of peeking at a buffered TLS stream for a ClientHello SNI.
 *  - found:     a complete ClientHello with a server_name extension
 *  - need-more: the bytes so far are a valid prefix; keep buffering
 *  - none:      not TLS, malformed, or a complete hello without SNI;
 *               callers must fail closed
 */
export type SniPeekResult =
  | { kind: 'found'; serverName: string }
  | { kind: 'need-more' }
  | { kind: 'none' }

/** Max TLSPlaintext fragment length (RFC 8446 §5.1). */
const MAX_TLS_RECORD = 1 << 14

/**
 * Incrementally parse the start of a TLS stream for the ClientHello's SNI
 * hostname, including a ClientHello split across several handshake records.
 * Never throws; malformed input returns `none`.
 */
export function peekClientHelloSni(buf: Buffer): SniPeekResult {
  if (buf.length === 0) return { kind: 'need-more' }
  if (buf[0] !== 0x16) return { kind: 'none' } // not a TLS handshake record

  // Join the payloads of consecutive handshake records.
  const fragments: Buffer[] = []
  let offset = 0
  while (offset < buf.length) {
    if (offset + 5 > buf.length) break // partial record header — wait
    if (buf[offset] !== 0x16) return { kind: 'none' }
    const recLen = buf.readUInt16BE(offset + 3)
    if (recLen === 0 || recLen > MAX_TLS_RECORD) return { kind: 'none' }
    fragments.push(buf.subarray(offset + 5, Math.min(offset + 5 + recLen, buf.length)))
    offset += 5 + recLen
  }
  const hs = Buffer.concat(fragments)

  if (hs.length < 4) return { kind: 'need-more' }
  if (hs[0] !== 0x01) return { kind: 'none' } // not a ClientHello
  const helloLen = (hs[1] << 16) | (hs[2] << 8) | hs[3]
  if (hs.length < 4 + helloLen) return { kind: 'need-more' }
  const hello = hs.subarray(4, 4 + helloLen)

  // The ClientHello is complete, so any overrun below means malformed.
  let p = 2 + 32 // legacy_version + random
  if (hello.length < p + 1) return { kind: 'none' }
  p += 1 + hello[p] // legacy_session_id
  if (hello.length < p + 2) return { kind: 'none' }
  p += 2 + hello.readUInt16BE(p) // cipher_suites
  if (hello.length < p + 1) return { kind: 'none' }
  p += 1 + hello[p] // legacy_compression_methods
  if (hello.length < p + 2) return { kind: 'none' } // no extensions block
  const extEnd = p + 2 + hello.readUInt16BE(p)
  p += 2
  if (extEnd > hello.length) return { kind: 'none' }

  while (p + 4 <= extEnd) {
    const extType = hello.readUInt16BE(p)
    const extLen = hello.readUInt16BE(p + 2)
    p += 4
    if (p + extLen > extEnd) return { kind: 'none' }
    if (extType === 0x0000) {
      // server_name: list_len(2), then entries of type(1) + len(2) + name
      if (extLen < 2) return { kind: 'none' }
      const listEnd = Math.min(p + 2 + hello.readUInt16BE(p), p + extLen)
      let q = p + 2
      while (q + 3 <= listEnd) {
        const nameType = hello[q]
        const nameLen = hello.readUInt16BE(q + 1)
        q += 3
        if (q + nameLen > listEnd) return { kind: 'none' }
        if (nameType === 0) {
          const name = hello.subarray(q, q + nameLen).toString('utf8')
          if (!name || name.includes('\0')) return { kind: 'none' }
          return { kind: 'found', serverName: name.toLowerCase() }
        }
        q += nameLen
      }
      return { kind: 'none' }
    }
    p += extLen
  }
  return { kind: 'none' }
}

/** SNI hostname from a complete buffered ClientHello, or null. */
export function parseSniFromClientHello(buf: Buffer): string | null {
  const res = peekClientHelloSni(buf)
  return res.kind === 'found' ? res.serverName : null
}

/**
 * Split an HTTP/1.1 Host header into hostname and port. On the transparent
 * HTTP listener this header is the only record of the destination, so a
 * malformed value returns null rather than a guess.
 */
export function splitHostHeader(
  host: string,
  defaultPort: number,
): { hostname: string; port: number } | null {
  const trimmed = host.trim()
  if (!trimmed) return null

  // Bracketed IPv6: [::1] or [::1]:8080
  const v6 = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(trimmed)
  if (v6) {
    const port = v6[2] !== undefined ? Number(v6[2]) : defaultPort
    if (port < 1 || port > 65535) return null
    return { hostname: v6[1].toLowerCase(), port }
  }
  if (trimmed.includes('[') || trimmed.includes(']')) return null

  const colon = trimmed.indexOf(':')
  if (colon === -1) {
    return { hostname: trimmed.toLowerCase(), port: defaultPort }
  }
  // A second colon means an unbracketed IPv6 literal — not a valid Host.
  if (trimmed.indexOf(':', colon + 1) !== -1) return null
  const hostname = trimmed.slice(0, colon)
  const portStr = trimmed.slice(colon + 1)
  if (!hostname || !/^\d{1,5}$/.test(portStr)) return null
  const port = Number(portStr)
  if (port < 1 || port > 65535) return null
  return { hostname: hostname.toLowerCase(), port }
}
