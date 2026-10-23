/**
 * The proxy's floor under every workspace allowlist (docs/workspace-egress.md
 * "Non-public destinations"). Before a direct upstream dial the destination
 * is resolved, and refused if any address is not publicly routable, unless
 * an exact allowlist entry names the host. The dial then goes to exactly the
 * addresses checked, so a name that answers differently the second time
 * (DNS rebinding) cannot slip past.
 */

import net from 'node:net'
import type { LookupAddress } from 'node:dns'

/**
 * Every IPv4 address that is not publicly routable: the IANA special-purpose
 * registry, plus Azure's WireServer, a metadata service on a public address.
 */
const NON_PUBLIC_V4 = new net.BlockList()
for (const [prefix, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3], // multicast, reserved and broadcast
  ['168.63.129.16', 32],
] as const) NON_PUBLIC_V4.addSubnet(prefix, bits, 'ipv4')

/**
 * The destination `hostname` names, in the form the allowlist is matched
 * against and the dial uses: read as a URL parser reads it, so it is
 * lowercased and odd IPv4 spellings (`0x7f.1`, `2130706433`) become dotted
 * quads. Throws UpstreamRefused for anything but a host name or an IPv4
 * address, IPv6 included: the proxy dials IPv4 only (docs/workspace-egress.md
 * "IPv4 only").
 */
export function upstreamHost(hostname: string): string {
  if (hostname.includes(':')) {
    throw new UpstreamRefused(`${hostname} is an IPv6 address; the proxy dials IPv4 only`)
  }
  if (/^[\w.-]+$/.test(hostname)) {
    try {
      return new URL(`http://${hostname}/`).hostname
    } catch { /* refused below */ }
  }
  throw new UpstreamRefused(`${hostname} is not a valid host`)
}

/** True when `address` is a publicly routable IPv4 address. */
export function isPublicAddress(address: string): boolean {
  return net.isIPv4(address) && !NON_PUBLIC_V4.check(address, 'ipv4')
}

/**
 * True for an upstream (an `upstreamHost`) Tor cannot dial (a non-public
 * address) or should not (an in-cluster service name). Under USE_TOR these
 * are dialed directly. This changes routing only; the host must still be on
 * the workspace's allowlist.
 */
export function isInternalUpstream(host: string): boolean {
  if (net.isIPv4(host)) return !isPublicAddress(host)
  const name = host.replace(/\.$/, '')
  return name === 'localhost' || name.endsWith('.localhost')
    || name.endsWith('.svc') || name.endsWith('.cluster.local')
}

/** A destination the guard will not dial; the message says why. */
export class UpstreamRefused extends Error {}

/**
 * A direct dial's checked addresses. `nonPublic` is one of them when an
 * allowlist entry admitted a non-public destination, else null.
 */
export interface DirectUpstream {
  addrs: LookupAddress[]
  nonPublic: string | null
}

/**
 * Resolve `host` (an `upstreamHost`) once through `lookup` for a direct
 * dial, keeping its IPv4 addresses. Throws UpstreamRefused when any is
 * non-public and `admitNonPublic` (an exact allowlist entry for the host) is
 * false.
 */
export async function resolveUpstream(
  host: string,
  admitNonPublic: boolean,
  lookup: (hostname: string) => Promise<LookupAddress[]>,
): Promise<DirectUpstream> {
  const addrs = net.isIPv4(host)
    ? [{ address: host, family: 4 }]
    : (await lookup(host)).filter((a) => net.isIPv4(a.address))
  if (addrs.length === 0) throw new Error(`${host} has no IPv4 address`)
  const nonPublic = addrs.find((a) => !isPublicAddress(a.address))?.address ?? null
  if (nonPublic !== null && !admitNonPublic) {
    throw new UpstreamRefused(`${named(host, nonPublic)} is a non-public address, which only an `
      + 'exact allowlist entry for it admits, not * or a wildcard')
  }
  return { addrs, nonPublic }
}

/** `host`, with the address it resolved to when that differs. */
function named(host: string, address: string): string {
  return host === address ? host : `${host} (${address})`
}

/** A dial's `lookup` answering only with `addrs`, the addresses already checked. */
export function pinnedLookup(addrs: LookupAddress[]): net.LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, addrs)
    else callback(null, addrs[0].address, addrs[0].family)
  }
}

/**
 * Request options that dial only `upstream`'s checked addresses. An admitted
 * non-public dial gets a socket of its own, outside the shared keep-alive
 * pool: the pool is keyed by host and port, not by workspace, so a pooled
 * socket would carry one workspace's admission into another's request.
 */
export function dialOptions(upstream: DirectUpstream): { lookup: net.LookupFunction; agent?: false } {
  return upstream.nonPublic === null
    ? { lookup: pinnedLookup(upstream.addrs) }
    : { lookup: pinnedLookup(upstream.addrs), agent: false }
}

/** How long an admitted non-public dial may take to connect. */
export const NON_PUBLIC_CONNECT_TIMEOUT_MS = 5_000

/**
 * Fail `socket`'s connect after NON_PUBLIC_CONNECT_TIMEOUT_MS when it dials
 * a non-public address. The cluster's egress policy drops such a dial
 * silently unless the network operator opened it, so it would otherwise
 * hang. A public dial keeps the system's connect timeout.
 */
export function failFastIfNonPublic(socket: net.Socket, host: string, upstream: DirectUpstream): void {
  const address = upstream.nonPublic
  if (address === null || !socket.connecting) return
  const timer = setTimeout(() => socket.destroy(new Error(
    `${named(host, address)} did not answer within ${NON_PUBLIC_CONNECT_TIMEOUT_MS / 1000}s. `
    + 'Non-public addresses are blocked by the cluster\'s egress policy unless the network operator '
    + 'opens them (docs/workspace-egress.md "Opening an internal destination")',
  )), NON_PUBLIC_CONNECT_TIMEOUT_MS)
  socket.once('connect', () => clearTimeout(timer))
  socket.once('close', () => clearTimeout(timer))
}
