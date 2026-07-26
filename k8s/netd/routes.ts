/**
 * pod IP → host-side veth resolution.
 *
 * The redirect is keyed on the interface a frame ARRIVES on, not on its
 * source IP: that is the one property a sandboxed workload cannot forge
 * (a gVisor netstack guest cannot emit raw frames at all, and Felix's
 * per-endpoint anti-spoof plus rp_filter cover the runc case). So netd
 * needs the pod → veth binding, and it must come from something
 * declarative rather than CRI inspection.
 *
 * Calico supplies exactly that in the node's routing table: for every
 * local workload it installs a host route `<podIP> dev cali<hash> scope
 * link`. (The `WorkloadEndpoint` resource would be the tidier source, but
 * it is served only by the optional Calico apiserver, which yaac
 * deliberately does not install — the vendored manifest is the plain
 * KDD one.)
 *
 * Pure parsing here; the caller supplies `ip route show` output.
 */

/** A Calico workload veth as seen from the node root netns. */
export interface PodVeth {
  podIp: string
  /** Host-side interface name, e.g. `calia132c78e002`. */
  iface: string
}

/**
 * Interface-name prefix Calico gives every workload veth. Matching on it
 * (rather than on any `dev` in the table) keeps node-level routes — the
 * default route, the podman bridge, tunnel devices — out of the map, so a
 * malformed table can never make netd redirect something that is not a
 * workload.
 */
const CALICO_VETH_PREFIX = 'cali'

/** Dotted-quad with no leading zeros and every octet in range. */
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/

/**
 * Parse `ip route show` output into the podIP → veth map.
 *
 * Matches only single-address (`/32`, i.e. no prefix suffix) `scope link`
 * routes pointing at a `cali*` device — the exact shape Calico writes per
 * workload:
 *
 *     10.244.169.197 dev calia132c78e002 scope link
 *
 * Anything else (blackhole aggregates for the node's IPAM block, the
 * default route, tunnel routes) is ignored. Later entries win, matching
 * the kernel's own "most recently installed route for this destination"
 * behaviour after a pod is replaced on the same IP.
 */
export function parsePodVeths(ipRouteOutput: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const rawLine of ipRouteOutput.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const fields = line.split(/\s+/)
    const dest = fields[0]
    if (!IPV4_RE.test(dest)) continue
    const devIdx = fields.indexOf('dev')
    if (devIdx < 0) continue
    const iface = fields[devIdx + 1]
    if (!iface?.startsWith(CALICO_VETH_PREFIX)) continue
    // `scope link` is what distinguishes a workload route from a via-route
    // that happens to egress a cali device.
    if (!/\bscope link\b/.test(line)) continue
    map.set(dest, iface)
  }
  return map
}

/** Sorted podVeth list — deterministic ordering for rendering and tests. */
export function podVethList(map: Map<string, string>): PodVeth[] {
  return [...map.entries()]
    .map(([podIp, iface]) => ({ podIp, iface }))
    .sort((a, b) => (a.podIp < b.podIp ? -1 : a.podIp > b.podIp ? 1 : 0))
}
