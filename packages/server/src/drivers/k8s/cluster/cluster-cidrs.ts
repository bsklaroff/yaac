import { listObjects, readObject } from '#drivers/k8s/substrate'

/**
 * CIDR literals for the network policies. NetworkPolicy can only name the
 * node's network namespace (kubelet probes, containerd pulls) by `ipBlock`,
 * so node addresses are resolved here, in one place. Node
 * addresses are single hosts: a wider block would admit everything on the
 * subnet, including the registry container on the local podman network.
 */

interface RawNode {
  metadata?: { annotations?: Record<string, string> }
  spec?: { podCIDRs?: string[] }
  status?: { addresses?: Array<{ type?: string; address?: string }> }
}

/**
 * Node annotations holding Calico's tunnel address, on clusters running
 * Calico (a byo one, or a kind cluster created before kindnet). Host
 * traffic to a pod on another node is sourced from it, not the InternalIP.
 */
const CALICO_TUNNEL_ANNOTATIONS = [
  'projectcalico.org/IPv4IPIPTunnelAddr',
  'projectcalico.org/IPv4VXLANTunnelAddr',
  'projectcalico.org/IPv4WireguardInterfaceAddr',
] as const

/**
 * Set on a node whose pods flannel carries over VXLAN (k3s's default CNI).
 * Its `flannel.1` device holds the network address of the node's pod CIDR,
 * and host traffic to a pod on another node, such as a NodePort pull
 * masqueraded on its way to the registry, is sourced from it. The network
 * address is never a pod's.
 */
const FLANNEL_BACKEND_ANNOTATION = 'flannel.alpha.coreos.com/backend-type'

/** The host addresses a node's own CNI sends cross-node host traffic from. */
function tunnelAddresses(node: RawNode): string[] {
  const annotations = node.metadata?.annotations ?? {}
  const calico = CALICO_TUNNEL_ANNOTATIONS
    .map((key) => annotations[key])
    .filter((addr): addr is string => !!addr)
  const flannel = annotations[FLANNEL_BACKEND_ANNOTATION] === 'vxlan'
    ? (node.spec?.podCIDRs ?? []).map((cidr) => cidr.split('/')[0])
    : []
  return [...calico, ...flannel]
}

/**
 * Cached. Node addresses change when nodes join or leave; node-sync re-reads
 * them (`nodeIpBlocks({ fresh: true })`) each resync, which refreshes the
 * cache for every other caller.
 */
let nodeCidrCache: string[] | null = null
let nodeAddressCache: string[] | null = null

/** Drop the caches (tests, and after a cluster rebuild). */
export function resetClusterCidrCache(): void {
  nodeCidrCache = null
  nodeAddressCache = null
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
  const tunnels = items.flatMap((n) => tunnelAddresses(n).map(hostCidr))
  const sources = [...new Set([...ofType('InternalIP'), ...tunnels])].sort()
  if (sources.length === 0) {
    throw new Error(
      'could not resolve any node InternalIP — the policies need it '
      + 'to admit the kubelet probes and containerd pulls',
    )
  }
  nodeCidrCache = sources
  nodeAddressCache = [...new Set([...sources, ...ofType('ExternalIP')])].sort()
}

/**
 * Every node's InternalIP (and CNI tunnel address) as a host CIDR: how
 * the policies admit traffic from the host netns (kubelet probes,
 * containerd pulls). Throws if none resolve, since an empty set would
 * silently cut off the probes. Cached; `fresh` re-reads the
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
