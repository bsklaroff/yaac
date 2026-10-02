/**
 * DNS wire-format helpers for the proxy's UDP/53 stub. Workspace pods use the
 * proxy as their resolver, and main.ts answers split-horizon:
 *
 *   - External names get a fixed sinkhole IP. netd redirects egress by port
 *     and the proxy routes by SNI / Host, so the address never matters, and
 *     resolving nothing real keeps DNS tunnelling closed.
 *   - Internal names (see isInternalName) are resolved by the cluster DNS so
 *     pods find in-cluster Services such as the per-project registry.
 *
 * Anything other than IN/A (including AAAA) gets an empty NOERROR rather than
 * NXDOMAIN, so dual-query resolvers fall through to the A answer. The TC bit
 * is never set, so resolvers never retry over TCP.
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
  /** Decoded QNAME: lowercased dotted labels, no trailing dot (`''` for root). */
  name: string
  /** Raw question section (QNAME + QTYPE + QCLASS), echoed verbatim. */
  question: Buffer
}

/**
 * True for names the proxy resolves against the cluster DNS instead of
 * sinkholing. Security-relevant: only `.cluster.local` qualifies, because
 * CoreDNS answers that zone itself. Any other name would be forwarded to an
 * outside resolver and open a DNS exfiltration channel, so the server always
 * uses `.svc.cluster.local` FQDNs. The API server's name is excluded, since
 * workspaces have no reason to reach it.
 */
export function isInternalName(name: string): boolean {
  const n = name.toLowerCase().replace(/\.$/, '')
  if (n === 'kubernetes.default.svc.cluster.local') return false
  return n.endsWith('.cluster.local')
}

/**
 * Parse a DNS query. Returns null (the caller drops the packet) for anything
 * the stub should not answer: truncated packets, responses (QR=1),
 * multi-question packets, or malformed names. Trailing bytes after the
 * question (such as EDNS OPT records) are ignored; the response carries no
 * EDNS.
 */
export function parseDnsQuery(buf: Buffer): DnsQuery | null {
  if (buf.length < 12) return null
  const flags = buf.readUInt16BE(2)
  if (flags & 0x8000) return null // QR=1: a response, not a query
  if (buf.readUInt16BE(4) !== 1) return null // exactly one question

  // Compression pointers (len > 63) never appear in a query's first name.
  let off = 12
  const labels: string[] = []
  for (;;) {
    if (off >= buf.length) return null
    const len = buf[off]
    if (len === 0) { off += 1; break }
    if (len > 63) return null
    if (off + 1 + len > buf.length) return null
    labels.push(buf.toString('latin1', off + 1, off + 1 + len).toLowerCase())
    off += 1 + len
  }
  if (off + 4 > buf.length) return null

  return {
    id: buf.readUInt16BE(0),
    opcode: (flags >> 11) & 0xf,
    rd: (flags & 0x0100) !== 0,
    qtype: buf.readUInt16BE(off),
    qclass: buf.readUInt16BE(off + 2),
    name: labels.join('.'),
    question: buf.subarray(12, off + 4),
  }
}

/**
 * Build the stub's response to a parsed query: a single A answer for IN/A when
 * `ipv4` is given, an empty NOERROR otherwise. A null `ipv4` is used when an
 * internal name failed to resolve, so the client sees no A record rather than
 * a sinkhole address.
 */
export function buildDnsResponse(query: DnsQuery, ipv4: string | null): Buffer {
  const answers = ipv4 !== null && query.qtype === DNS_QTYPE_A && query.qclass === DNS_QCLASS_IN ? 1 : 0

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
  rr.writeUInt32BE(60, 6) // TTL — low; ClusterIPs are stable, cluster DNS caches
  rr.writeUInt16BE(4, 10) // RDLENGTH
  Buffer.from((ipv4 as string).split('.').map((n) => parseInt(n, 10))).copy(rr, 12)
  return Buffer.concat([header, query.question, rr])
}
