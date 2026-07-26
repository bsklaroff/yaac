/**
 * IPv4 CIDR containment — the arithmetic behind netd's target invariant
 * ("every redirect target is a pod IP", see targets.ts).
 *
 * Hand-rolled because netd's whole dependency set is the Kubernetes client:
 * the check is a mask compare, and a wrong answer in the permissive
 * direction is a bypass, so it is worth owning outright and unit-testing.
 *
 * IPv4 only. A cluster CIDR netd cannot parse matches nothing, which fails
 * in the safe direction: an unparseable target is refused rather than
 * admitted.
 */

/** Dotted-quad → unsigned 32-bit host order; null when malformed. */
export function parseIpv4(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = value * 256 + octet
  }
  return value >>> 0
}

export interface Ipv4Cidr {
  base: number
  bits: number
}

/** `10.244.0.0/16` → base + prefix length; null when malformed. */
export function parseIpv4Cidr(cidr: string): Ipv4Cidr | null {
  const slash = cidr.indexOf('/')
  if (slash < 0) return null
  const base = parseIpv4(cidr.slice(0, slash))
  const prefix = cidr.slice(slash + 1)
  if (base === null || !/^\d{1,2}$/.test(prefix)) return null
  const bits = Number(prefix)
  if (bits > 32) return null
  return { base, bits }
}

/** Is `ip` inside `cidr`? False for anything either side cannot parse. */
export function ipInCidr(ip: string, cidr: string): boolean {
  const addr = parseIpv4(ip)
  const parsed = parseIpv4Cidr(cidr)
  if (addr === null || parsed === null) return false
  // A 32-bit shift is a no-op in JS (the count is taken mod 32), so /0 —
  // which matches everything — has to be spelled out.
  if (parsed.bits === 0) return true
  const mask = (0xffffffff << (32 - parsed.bits)) >>> 0
  return ((addr & mask) >>> 0) === ((parsed.base & mask) >>> 0)
}

/** Is `ip` inside any of `cidrs`? Empty list matches nothing. */
export function ipInAnyCidr(ip: string, cidrs: string[]): boolean {
  return cidrs.some((cidr) => ipInCidr(ip, cidr))
}
