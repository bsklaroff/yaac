/**
 * Maps pod IPs to host-side veths by parsing `ip route show` output.
 *
 * Redirect rules match the interface a packet arrives on rather than its
 * source IP, because a workload cannot forge its interface. Calico
 * installs a host route `<podIP> dev cali<hash> scope link` for each local
 * workload, which gives the mapping. (WorkloadEndpoint objects would too,
 * but they need the optional Calico apiserver, which yaac does not
 * install.)
 */

/**
 * Interface-name prefix Calico gives workload veths. Other CNIs may use a
 * different one (e.g. `eni` with the AWS VPC CNI), but a prefix is always
 * required so node-level routes (default route, bridges, tunnels) are
 * never treated as workloads.
 */
export const DEFAULT_VETH_PREFIX = 'cali'

/** Prefix characters an interface name can actually contain. */
const VETH_PREFIX_RE = /^[A-Za-z0-9_.@-]+$/

/**
 * The veth prefix to match on, from a configured value. Empty or
 * implausible values fall back to the default, since an empty prefix
 * would match every device.
 */
export function normalizeVethPrefix(raw: string | undefined): string {
  const value = raw?.trim() ?? ''
  if (value === '' || !VETH_PREFIX_RE.test(value)) return DEFAULT_VETH_PREFIX
  return value
}

/** Dotted-quad with no leading zeros and every octet in range. */
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/

/**
 * Parse `ip route show` output into a podIP → veth map. Only single-address
 * `scope link` routes on a `<prefix>*` device count, the shape Calico
 * writes per workload:
 *
 *     10.244.169.197 dev calia132c78e002 scope link
 *
 * Later entries win, for a pod replaced on the same IP.
 */
export function parsePodVeths(
  ipRouteOutput: string,
  prefix: string = DEFAULT_VETH_PREFIX,
): Map<string, string> {
  const map = new Map<string, string>()
  const vethPrefix = normalizeVethPrefix(prefix)
  for (const rawLine of ipRouteOutput.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const fields = line.split(/\s+/)
    const dest = fields[0]
    if (!IPV4_RE.test(dest)) continue
    const devIdx = fields.indexOf('dev')
    if (devIdx < 0) continue
    const iface = fields[devIdx + 1]
    if (!iface?.startsWith(vethPrefix)) continue
    // Excludes via-routes that happen to use a cali device.
    if (!/\bscope link\b/.test(line)) continue
    map.set(dest, iface)
  }
  return map
}
