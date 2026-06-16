/**
 * Minimal DNS wire-format helpers for the proxy's UDP/53 stub — pure (no
 * deps, no I/O). Session pods point their resolver (dnsConfig.nameservers) at
 * the proxy VIP; the stub answers every A query with a fixed dummy IP.
 *
 * The resolved IP is decorative: Cilium redirects egress by port (443/80), and
 * the proxy routes by TLS SNI / HTTP Host — never by the dialed address. So a
 * constant dummy answer is all a client needs, and resolving nothing real
 * keeps the DNS-tunnelling channel closed. Everything that is not IN/A (AAAA
 * included) gets an empty NOERROR — not NXDOMAIN — so dual-query resolvers
 * fall through to the A answer. The TC bit is never set, so resolvers never
 * retry over tcp/53.
 */

export const DNS_QTYPE_A = 1
export const DNS_QCLASS_IN = 1

export interface DnsQuery {
  id: number
  /** Opcode bits, echoed into the response. */
  opcode: number
  /** RD (recursion desired) bit, echoed into the response. */
  rd: boolean
  qtype: number
  qclass: number
  /** Raw question section (QNAME + QTYPE + QCLASS), echoed verbatim. */
  question: Buffer
}

/**
 * Parse a DNS query. Returns null (the caller drops the packet) for anything
 * the stub should not answer: truncated packets, responses (QR=1),
 * multi-question packets, or malformed names. Trailing bytes after the
 * question (EDNS OPT records in the additional section) are tolerated and
 * ignored — the response simply carries no EDNS, which is fine here.
 */
export function parseDnsQuery(buf: Buffer): DnsQuery | null {
  if (buf.length < 12) return null
  const flags = buf.readUInt16BE(2)
  if (flags & 0x8000) return null // QR=1: a response, not a query
  if (buf.readUInt16BE(4) !== 1) return null // exactly one question

  // QNAME: length-prefixed labels, 0-terminated. Compression pointers
  // (len > 63) never appear in a query's first name, so treat as malformed.
  let off = 12
  for (;;) {
    if (off >= buf.length) return null
    const len = buf[off]
    if (len === 0) { off += 1; break }
    if (len > 63) return null
    off += 1 + len
  }
  if (off + 4 > buf.length) return null

  return {
    id: buf.readUInt16BE(0),
    opcode: (flags >> 11) & 0xf,
    rd: (flags & 0x0100) !== 0,
    qtype: buf.readUInt16BE(off),
    qclass: buf.readUInt16BE(off + 2),
    question: buf.subarray(12, off + 4),
  }
}

/**
 * Build the stub's response to a parsed query: a single fixed A answer for
 * IN/A, an empty NOERROR for everything else. Never truncated.
 */
export function buildDnsResponse(query: DnsQuery, dummyIpv4: string): Buffer {
  const answers = query.qtype === DNS_QTYPE_A && query.qclass === DNS_QCLASS_IN ? 1 : 0

  const header = Buffer.alloc(12)
  header.writeUInt16BE(query.id, 0)
  // QR=1 | opcode (echoed) | RD (echoed) | RA=1, RCODE=0 (NOERROR).
  header.writeUInt16BE(0x8080 | (query.opcode << 11) | (query.rd ? 0x0100 : 0), 2)
  header.writeUInt16BE(1, 4) // QDCOUNT: the echoed question
  header.writeUInt16BE(answers, 6) // ANCOUNT
  if (answers === 0) return Buffer.concat([header, query.question])

  const rr = Buffer.alloc(16)
  rr.writeUInt16BE(0xc00c, 0) // name: compression pointer to the QNAME
  rr.writeUInt16BE(DNS_QTYPE_A, 2)
  rr.writeUInt16BE(DNS_QCLASS_IN, 4)
  rr.writeUInt32BE(60, 6) // TTL — low; the answer is constant anyway
  rr.writeUInt16BE(4, 10) // RDLENGTH
  Buffer.from(dummyIpv4.split('.').map((n) => parseInt(n, 10))).copy(rr, 12)
  return Buffer.concat([header, query.question, rr])
}
