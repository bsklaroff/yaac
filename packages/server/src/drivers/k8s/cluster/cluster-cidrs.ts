import { isAbsent, k8sErrorSummary, listObjects, readObject } from '#drivers/k8s/substrate'
import { env } from '@yaac/shared/env'
import { serverLog } from '#lib/log'

/**
 * CIDR literals for the network policies and netd. NetworkPolicy can only
 * name the node's network namespace (where netd's Envoy delivers from) by
 * `ipBlock`, so node addresses are resolved here, in one place. Node
 * addresses are single hosts: a wider block would admit everything on the
 * subnet, including the registry container on the local podman network.
 */

interface RawNode {
  metadata?: { annotations?: Record<string, string> }
  status?: { addresses?: Array<{ type?: string; address?: string }> }
}

/**
 * Node annotations holding Calico's tunnel address. Host traffic to a pod on
 * another node is sourced from it, not the InternalIP.
 */
const CALICO_TUNNEL_ANNOTATIONS = [
  'projectcalico.org/IPv4IPIPTunnelAddr',
  'projectcalico.org/IPv4VXLANTunnelAddr',
  'projectcalico.org/IPv4WireguardInterfaceAddr',
] as const

interface RawPodCidrNode {
  spec?: { podCIDR?: string; podCIDRs?: string[] }
}

interface RawIpPool {
  spec?: { cidr?: string; disabled?: boolean }
}

/**
 * Cached. Node addresses change when nodes join or leave; node-sync re-reads
 * them (`nodeIpBlocks({ fresh: true })`) each resync, which refreshes the
 * cache for every other caller.
 */
let nodeCidrCache: string[] | null = null
let nodeAddressCache: string[] | null = null
let podCidrCache: string[] | null = null

/** Drop the caches (tests, and after a cluster rebuild). */
export function resetClusterCidrCache(): void {
  nodeCidrCache = null
  nodeAddressCache = null
  podCidrCache = null
}

/** An address as a single-host CIDR, `/128` for IPv6. */
function hostCidr(address: string): string {
  return `${address}/${address.includes(':') ? 128 : 32}`
}

/** Read the nodes once and fill both node caches. */
async function readNodeAddresses(): Promise<void> {
  const items = await listObjects<RawNode>('v1', 'Node')
  const ofType = (type: string): string[] => items
    .flatMap((n) => n.status?.addresses ?? [])
    .filter((a) => a.type === type && a.address)
    .map((a) => hostCidr(a.address!))
  // Tunnel addresses matter only on multi-node clusters.
  const tunnels = items.flatMap((n) =>
    CALICO_TUNNEL_ANNOTATIONS
      .map((key) => n.metadata?.annotations?.[key])
      .filter((addr): addr is string => !!addr)
      .map(hostCidr))
  const sources = [...new Set([...ofType('InternalIP'), ...tunnels])].sort()
  if (sources.length === 0) {
    throw new Error(
      'could not resolve any node InternalIP — the egress policies need it '
      + 'to admit netd\'s redirect delivery and the kubelet probes',
    )
  }
  nodeCidrCache = sources
  nodeAddressCache = [...new Set([...sources, ...ofType('ExternalIP')])].sort()
}

/**
 * Every node's InternalIP (and Calico tunnel address) as a host CIDR: how
 * the policies admit traffic from the host netns (netd's Envoy, kubelet
 * probes, containerd pulls). Throws if none resolve, since an empty set
 * would silently cut off all workspace egress. Cached; `fresh` re-reads the
 * nodes, which `reconcileNodeSet` does to notice a node joining.
 */
export async function nodeIpBlocks(opts: { fresh?: boolean } = {}): Promise<string[]> {
  if (!nodeCidrCache || opts.fresh) await readNodeAddresses()
  return nodeCidrCache!
}

/**
 * Every address a node answers on, as host CIDRs: `nodeIpBlocks` plus each
 * ExternalIP. Egress policies cut these from the public block. A cloud
 * node's ExternalIP is public, and a pod dialing its own node's is
 * delivered locally, past any cloud firewall, to the kubelet, every
 * NodePort and the machine's own daemons. Shares `nodeIpBlocks`' cache.
 */
export async function nodeAddressBlocks(opts: { fresh?: boolean } = {}): Promise<string[]> {
  if (!nodeAddressCache || opts.fresh) await readNodeAddresses()
  return nodeAddressCache!
}

/**
 * The cluster DNS Service's addresses (`kube-system/kube-dns`), as `/32` or
 * `/128` CIDRs. NodeLocal DNSCache in its kube-proxy-iptables mode answers
 * on this ClusterIP itself and skips kube-proxy's DNAT, so policy sees the
 * Service address rather than a CoreDNS pod. Empty when there is no such
 * Service.
 */
export async function clusterDnsCidrs(): Promise<string[]> {
  const svc = await readObject<{ spec?: { clusterIPs?: string[] } }>({
    apiVersion: 'v1', kind: 'Service', name: 'kube-dns', namespace: 'kube-system',
  })
  return (svc?.spec?.clusterIPs ?? [])
    .filter((ip) => ip !== 'None')
    .map(hostCidr)
}

interface RawEndpointSlice {
  addressType?: string
  endpoints?: Array<{ addresses?: string[] }>
  ports?: Array<{ port?: number }>
}

/**
 * The apiserver's real endpoints, as `/32` or `/128` CIDRs and ports, from
 * the `kubernetes` Service's EndpointSlices. Policy sees a destination after
 * kube-proxy's DNAT, so the proxy's egress must name these, not the Service
 * address. Empty when none are published.
 */
export async function apiserverEndpoints(): Promise<{ cidrs: string[]; ports: number[] }> {
  const slices = await listObjects<RawEndpointSlice>('discovery.k8s.io/v1', 'EndpointSlice', {
    namespace: 'default', labelSelector: 'kubernetes.io/service-name=kubernetes',
  })
  const cidrs = slices.flatMap((s) => (s.endpoints ?? []).flatMap((e) => e.addresses ?? [])
    .map((a) => `${a}/${s.addressType === 'IPv6' ? 128 : 32}`))
  const ports = slices.flatMap((s) => (s.ports ?? []).flatMap((p) => p.port ?? []))
  return { cidrs: [...new Set(cidrs)].sort(), ports: [...new Set(ports)].sort((a, b) => a - b) }
}

/** kind's default cluster CIDR, and the last resort when nothing answers. */
const FALLBACK_POD_CIDR = '10.244.0.0/16'

/**
 * A valid IPv4 CIDR. Range-checked because one bad line makes
 * `iptables-restore` reject netd's whole rule set.
 */
function isIpv4Cidr(value: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(value)
  if (!m) return false
  const octets = [m[1], m[2], m[3], m[4]].map(Number)
  return octets.every((o) => o <= 255) && Number(m[5]) <= 32
}

function normalize(cidrs: string[]): string[] {
  return [...new Set(cidrs.filter(isIpv4Cidr))].sort()
}

/** The entries `normalize` drops, for the caller to report. */
function rejected(cidrs: string[]): string[] {
  return [...new Set(cidrs.filter((c) => !isIpv4Cidr(c)))].sort()
}

/**
 * Every CIDR pods get IPs from: netd's exclusion list, which keeps
 * pod-to-pod traffic out of the redirect. A list that is too narrow is the
 * dangerous case (pod-to-pod 443/80 would go to the proxy), so all sources
 * are unioned:
 *
 *  - `YAAC_POD_CIDRS`, for clusters whose IPAM publishes nothing readable
 *    (e.g. AWS VPC CNI).
 *  - Calico IPPools, including disabled ones (which still hold live IPs).
 *    Calico is the IPAM on every cluster yaac builds, and its IPs often
 *    fall outside the node's `spec.podCIDR`.
 *  - `spec.podCIDR` of every node, for CNIs that use it.
 *  - kind's default, only if nothing else answers.
 */
export async function clusterPodCidrs(): Promise<string[]> {
  if (podCidrCache) return podCidrCache
  const { configured, pools, nodes, droppedConfigured } = await podCidrSources()
  if (droppedConfigured.length > 0) {
    // `--byo` refuses on these; here the redirect must still be applied,
    // so log loudly.
    serverLog(
      `[netd] ignoring unusable YAAC_POD_CIDRS entries: ${droppedConfigured.join(', ')} `
      + '— pods addressed from them will be treated as world and redirected',
    )
  }
  const resolved = normalize([...configured, ...pools, ...nodes])
  podCidrCache = resolved.length > 0 ? resolved : [FALLBACK_POD_CIDR]
  return podCidrCache
}

/**
 * The pod CIDR sources, kept separate for the `--byo` gate, which needs to
 * know which answered (only `spec.podCIDR` on a foreign cluster suggests
 * the list is too narrow). Uncached; it runs once per adoption.
 */
export async function podCidrSources(): Promise<{
  configured: string[]
  pools: string[]
  nodes: string[]
  /** Invalid `YAAC_POD_CIDRS` entries, reported so a typo does not
   *  silently narrow the exclusion set. */
  droppedConfigured: string[]
  /** Sources whose read failed for a reason other than not existing (e.g.
   *  RBAC denial), which would otherwise silently narrow the set. `--byo`
   *  refuses on these. */
  unreadable: Array<{ source: string; cause: string }>
}> {
  const configured = normalize(env.podCidrs)
  const droppedConfigured = rejected(env.podCidrs)
  const unreadable: Array<{ source: string; cause: string }> = []

  /** Read a source, telling "not served" from "could not read". */
  const read = async <T>(source: string, apiVersion: string, kind: string): Promise<T[]> => {
    try {
      return await listObjects<T>(apiVersion, kind)
    } catch (err) {
      if (!isAbsent(err)) {
        unreadable.push({ source, cause: k8sErrorSummary(err) })
      }
      return []
    }
  }

  // Not served at all on a cluster without Calico.
  const pools = await read<RawIpPool>('Calico IPPools', 'crd.projectcalico.org/v1', 'IPPool')
  // Disabled pools included: existing pods keep their addresses.
  const poolCidrs = normalize(pools.map((p) => p.spec?.cidr ?? ''))

  const nodes = await read<RawPodCidrNode>('node spec.podCIDR', 'v1', 'Node')
  const nodeCidrs = normalize(nodes
    .flatMap((n) => [n.spec?.podCIDR ?? '', ...(n.spec?.podCIDRs ?? [])]))

  return { configured, pools: poolCidrs, nodes: nodeCidrs, droppedConfigured, unreadable }
}
