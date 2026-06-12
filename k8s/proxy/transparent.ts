/**
 * Pure helpers for the proxy's transparent egress listeners.
 *
 * Zero dependencies and no boot-time side effects, so unit tests import
 * this module directly — proxy.ts itself reads required env and starts
 * listeners at module load, which makes it untestable by import. proxy.ts
 * pulls these in via a relative import; the Dockerfile copies both files.
 */

/**
 * Result of peeking at a buffered TLS stream for a ClientHello SNI.
 *  - found:     a complete ClientHello with a server_name extension
 *  - need-more: the bytes so far are a valid prefix — keep buffering
 *  - none:      definitely not parseable as a ClientHello-with-SNI
 *               (not TLS, malformed, or a complete hello without SNI) —
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
 * hostname. Handles a ClientHello fragmented across multiple handshake
 * records (legal, if rare). Never throws; every malformed shape maps to
 * `none` so the transparent listener fails closed.
 */
export function peekClientHelloSni(buf: Buffer): SniPeekResult {
  if (buf.length === 0) return { kind: 'need-more' }
  if (buf[0] !== 0x16) return { kind: 'none' } // not a TLS handshake record

  // Stitch handshake-record payloads together: a ClientHello may span
  // records, and every record before it completes must itself be a
  // handshake record.
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

  // From here the ClientHello is complete: any bounds overflow is
  // malformation, not missing bytes.
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

/**
 * SNI hostname from a complete buffered ClientHello, or null. Thin
 * convenience over `peekClientHelloSni` for callers that have the whole
 * hello in hand (the listener loop uses the peek form to keep buffering).
 */
export function parseSniFromClientHello(buf: Buffer): string | null {
  const res = peekClientHelloSni(buf)
  return res.kind === 'found' ? res.serverName : null
}

/**
 * Normalize a socket remoteAddress for use as an `ipToSession` key:
 * unwrap IPv4-mapped IPv6 (`::ffff:10.0.0.1` → `10.0.0.1`) and map
 * absent/empty addresses to null so callers fail closed.
 */
export function normalizeRemoteAddr(addr: string | null | undefined): string | null {
  if (!addr) return null
  const v4mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr)
  if (v4mapped) return v4mapped[1]
  return addr
}

/** Dotted-quad IPv4 → 32-bit int, or null when not an IPv4 literal. */
function parseIpv4(host: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return null
  const parts = m.slice(1).map(Number)
  if (parts.some((o) => o > 255)) return null
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
}

function inCidr(ip: number, base: number, maskBits: number): boolean {
  const mask = maskBits === 0 ? 0 : (~0 << (32 - maskBits)) >>> 0
  return (ip & mask) === (base & mask)
}

/**
 * True for upstreams Tor cannot (loopback/private/link-local IPs) or
 * should not (in-cluster service names) be asked to dial. Used to guard
 * the USE_TOR paths: the transparent listeners widened what can reach
 * the tunnel/forward code, so internal destinations now go direct
 * instead of erroring inside Tor. Reaching such a host still requires it
 * to be on the session's allowlist — this changes routing, not policy.
 */
export function isInternalUpstream(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.svc') || host.endsWith('.svc.cluster.local') || host.endsWith('.cluster.local')) {
    return true
  }

  // IPv6 literals: loopback, unspecified, unique-local, link-local, and
  // IPv4-mapped (recursed on the embedded IPv4).
  if (host.includes(':')) {
    const bare = host.replace(/^\[|\]$/g, '')
    if (bare === '::1' || bare === '::') return true
    if (/^f[cd]/.test(bare)) return true // fc00::/7
    if (/^fe[89ab]/.test(bare)) return true // fe80::/10
    const mapped = normalizeRemoteAddr(bare)
    if (mapped !== null && mapped !== bare) return isInternalUpstream(mapped)
    return false
  }

  const ip = parseIpv4(host)
  if (ip === null) return false
  return inCidr(ip, 0x7f000000, 8) // 127.0.0.0/8
    || inCidr(ip, 0x0a000000, 8) // 10.0.0.0/8
    || inCidr(ip, 0xac100000, 12) // 172.16.0.0/12
    || inCidr(ip, 0xc0a80000, 16) // 192.168.0.0/16
    || inCidr(ip, 0xa9fe0000, 16) // 169.254.0.0/16
    || inCidr(ip, 0x64400000, 10) // 100.64.0.0/10 (CGNAT)
    || ip === 0 // 0.0.0.0
}

/**
 * Split an HTTP/1.1 Host header into hostname + port. Origin-form
 * requests on the transparent HTTP listener carry the original
 * destination only here, so a malformed value must map to null (fail
 * closed) rather than a guess.
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
