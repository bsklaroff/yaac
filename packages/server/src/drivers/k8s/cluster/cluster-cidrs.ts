import { isKubectlAbsentError, kubectlErrorSummary, kubectlGetJson } from '#drivers/k8s/substrate'
import { env } from '@yaac/shared/env'
import { serverLog } from '#log'

/**
 * The CIDR literals the policies need.
 *
 * Plain NetworkPolicy can name pods and namespaces by label, but it has
 * no way to say "the node's network namespace" or "the apiserver" — its
 * only non-selector peer is `ipBlock`. Both matter here: netd's Envoy
 * delivers redirected egress from the host netns, and the vcluster
 * control plane must reach the host API. So those become concrete
 * addresses, resolved at apply time. Keeping the resolution in one module
 * (rather than inline in each ensure function) is what stops the policies
 * from disagreeing about what "the node" is.
 *
 * Everything is `/32`: the node set and the apiserver endpoint set are
 * both small and enumerable, and a wider block would silently admit
 * anything else sharing the subnet — on the local backend that subnet is
 * the podman network, which also hosts the registry container.
 */

interface RawNodeList {
  items?: Array<{
    metadata?: { annotations?: Record<string, string> }
    status?: { addresses?: Array<{ type?: string; address?: string }> }
  }>
}

/**
 * Calico publishes each node's overlay tunnel address as a node
 * annotation. Host-originated traffic to a pod on ANOTHER node leaves
 * through the tunnel and is sourced from that address, not the node's
 * InternalIP — so a policy naming only InternalIPs denies it.
 */
const CALICO_TUNNEL_ANNOTATIONS = [
  'projectcalico.org/IPv4IPIPTunnelAddr',
  'projectcalico.org/IPv4VXLANTunnelAddr',
  'projectcalico.org/IPv4WireguardInterfaceAddr',
] as const

interface RawEndpoints {
  subsets?: Array<{ addresses?: Array<{ ip?: string }> }>
}

interface RawPodCidrNodeList {
  items?: Array<{ spec?: { podCIDR?: string; podCIDRs?: string[] } }>
}

interface RawIpPoolList {
  items?: Array<{ spec?: { cidr?: string; disabled?: boolean } }>
}

/** Cached: node addresses change only when the cluster is rebuilt. */
let nodeCidrCache: string[] | null = null
let podCidrCache: string[] | null = null

/** Drop the caches (tests, and after a cluster rebuild). */
export function resetClusterCidrCache(): void {
  nodeCidrCache = null
  podCidrCache = null
}

/**
 * Every node's InternalIP as a `/32` — how the policies name the host
 * network namespace. Three flows arrive from there: netd's Envoy dialing
 * the proxy, the kubelet's readiness probes, and containerd pulling from
 * a project registry.
 *
 * Throws when no address resolves rather than returning an empty list: an
 * empty `ipBlock` set would render a policy that silently denies the
 * redirect delivery path, which presents as "all worktrees lost egress"
 * with no obvious cause.
 */
export async function nodeIpBlocks(): Promise<string[]> {
  if (nodeCidrCache) return nodeCidrCache
  const list = await kubectlGetJson<RawNodeList>(['get', 'nodes'])
  const items = list?.items ?? []
  const cidrs = items
    .flatMap((n) => n.status?.addresses ?? [])
    .filter((a) => a.type === 'InternalIP' && a.address)
    .map((a) => `${a.address!}/32`)
  // Plus each node's overlay tunnel address: on a multi-node cluster the
  // host netns reaches a pod on another node through the tunnel, and the
  // packet arrives sourced from there. Same-node delivery keeps working
  // off the InternalIP above, which is why this only shows up multi-node.
  const tunnels = items.flatMap((n) =>
    CALICO_TUNNEL_ANNOTATIONS
      .map((key) => n.metadata?.annotations?.[key])
      .filter((addr): addr is string => !!addr)
      .map((addr) => `${addr}/32`))
  const unique = [...new Set([...cidrs, ...tunnels])].sort()
  if (unique.length === 0) {
    throw new Error(
      'could not resolve any node InternalIP — the egress policies need it '
      + 'to admit netd\'s redirect delivery and the kubelet probes',
    )
  }
  nodeCidrCache = unique
  return unique
}

/**
 * The host apiserver's real endpoint addresses as `/32`s, used by the
 * vcluster control-plane and activator policies.
 *
 * Read from the `kubernetes` Endpoints in `default` rather than the
 * Service ClusterIP: NetworkPolicy is evaluated on the post-DNAT
 * destination, so a rule naming the VIP would never match. On kind that
 * endpoint is the node address itself, which is why this can return the
 * same value as `nodeIpBlocks()` — correct, not redundant.
 */
export async function apiserverIpBlocks(): Promise<string[]> {
  const endpoints = await kubectlGetJson<RawEndpoints>([
    'get', 'endpoints', 'kubernetes', '-n', 'default',
  ])
  const cidrs = (endpoints?.subsets ?? [])
    .flatMap((s) => s.addresses ?? [])
    .map((a) => a.ip)
    .filter((ip): ip is string => !!ip)
    .map((ip) => `${ip}/32`)
  const unique = [...new Set(cidrs)].sort()
  if (unique.length === 0) {
    // Fall back to the node set: on every backend yaac supports the
    // apiserver is reachable at a node address, and an empty list would
    // strand the vcluster control plane with no path to the host API.
    return nodeIpBlocks()
  }
  return unique
}

/** kind's default cluster CIDR, and the last resort when nothing answers. */
export const FALLBACK_POD_CIDR = '10.244.0.0/16'

/**
 * A dotted-quad CIDR, which is all the v4 nat rules can express — with
 * every octet and the mask actually in range.
 *
 * The range check is not pedantry: these strings become `-d <cidr>` in the
 * `iptables-restore` document netd applies, and `iptables-restore` rejects
 * the WHOLE document on one bad line. A `999.1.1.1/99` that reached the
 * renderer would stall every redirect update on the node, not just its own
 * rule.
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

/** The entries `normalize` would throw away — what the caller must report. */
function rejected(cidrs: string[]): string[] {
  return [...new Set(cidrs.filter((c) => !isIpv4Cidr(c)))].sort()
}

/**
 * Every CIDR the cluster allocates pod IPs from — netd's exclusion list,
 * which is what keeps pod-to-pod traffic out of the redirect.
 *
 * Sourced in preference order, because no single source is right
 * everywhere:
 *
 *  0. **Explicit config** (`YAAC_POD_CIDRS`). For a cluster yaac did not
 *     build, whose IPAM publishes its allocations nowhere the two sources
 *     below can read: an AWS VPC CNI hands out VPC subnet addresses that
 *     appear in no IPPool and no `spec.podCIDR`. Named first because it is
 *     the only source an operator controls, but it ADDS rather than
 *     overrides — see the too-narrow note below.
 *  1. **Calico IPPools**, including `disabled` ones — that flag stops new
 *     allocations, not existing ones. The authority wherever Calico does
 *     the IPAM, which is every cluster `yaac cluster setup` builds. Calico
 *     allocates /26 blocks from anywhere in its pool, so a pod's IP
 *     routinely falls outside its own node's `spec.podCIDR` — that field
 *     describes the kubeadm allocation Calico is not using.
 *  2. **`spec.podCIDR` across ALL nodes.** For clusters whose CNI does use
 *     the kubeadm per-node allocation. Every node, not the first one: on a
 *     multi-node cluster each holds a different slice.
 *  3. **kind's default.** Only when nothing above answers, which no
 *     cluster yaac installs into leaves true.
 *
 * Too NARROW is the dangerous direction — a pod IP outside the list is
 * treated as world and its pod-to-pod 443/80 gets redirected into the
 * proxy — so this unions its sources rather than picking a winner, and
 * never widens a CIDR it was given.
 */
export async function clusterPodCidrs(): Promise<string[]> {
  if (podCidrCache) return podCidrCache
  const { configured, pools, nodes, droppedConfigured } = await podCidrSources()
  if (droppedConfigured.length > 0) {
    // The adopt gate refuses on these; here — the per-apply path on a
    // running server — the redirect still has to be programmed, so this is
    // the loudest available signal that the exclusion set is narrower than
    // what was configured.
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
 * The three sources above, kept apart and unnormalized-into-one.
 *
 * `clusterPodCidrs` unions them; the `--adopt-cni` gate needs to know
 * WHICH answered, because "only node spec.podCIDR answered" on a cluster
 * yaac did not build is the shape where the exclusion set is most likely
 * too narrow — and too narrow means pod-to-pod 443/80 gets redirected into
 * the proxy. Uncached on purpose: this runs once per adoption, and the
 * cache exists for the per-apply path.
 */
export async function podCidrSources(): Promise<{
  configured: string[]
  pools: string[]
  nodes: string[]
  /**
   * `YAAC_POD_CIDRS` entries that are not a usable v4 CIDR. Reported, never
   * merely dropped: a typo'd entry that vanishes leaves the exclusion set
   * NARROWER than the operator believes it set, which is the dangerous
   * direction — the pods in that range get redirected into the proxy.
   */
  droppedConfigured: string[]
  /**
   * Sources whose read FAILED for a reason other than genuine absence —
   * an RBAC denial scoped to `ippools` alone, say, which would otherwise
   * present as "Calico publishes no pool" and silently narrow the set.
   * Absence stays a fact: a cluster without Calico serves no IPPool CRD,
   * and that is a source that does not exist rather than one we could not
   * read. `--adopt-cni` refuses on anything listed here.
   */
  unreadable: Array<{ source: string; cause: string }>
}> {
  const configured = normalize(env.podCidrs)
  const droppedConfigured = rejected(env.podCidrs)
  const unreadable: Array<{ source: string; cause: string }> = []

  /** A source read, distinguishing "not served" from "could not ask". */
  const read = async <T>(source: string, args: string[]): Promise<T | null> => {
    try {
      return await kubectlGetJson<T>(args)
    } catch (err) {
      if (!isKubectlAbsentError(err)) {
        unreadable.push({ source, cause: kubectlErrorSummary(err) })
      }
      return null
    }
  }

  // `ippools` is a Calico CRD; on a cluster without Calico it is not served
  // at all, which is a missing source and not an error.
  const pools = await read<RawIpPoolList>(
    'Calico IPPools', ['get', 'ippools.crd.projectcalico.org'],
  )
  // Disabled pools count. `disabled: true` stops NEW allocations; every pod
  // already holding an address from that pool keeps it, so a cluster
  // adopted mid-pool-migration still has live pod IPs in there. Excluding
  // them from the redirect is what the list is for, and a pool that is
  // disabled and fully drained costs nothing but a RETURN rule.
  const poolCidrs = normalize((pools?.items ?? []).map((p) => p.spec?.cidr ?? ''))

  const nodes = await read<RawPodCidrNodeList>('node spec.podCIDR', ['get', 'nodes'])
  const nodeCidrs = normalize((nodes?.items ?? [])
    .flatMap((n) => [n.spec?.podCIDR ?? '', ...(n.spec?.podCIDRs ?? [])]))

  return { configured, pools: poolCidrs, nodes: nodeCidrs, droppedConfigured, unreadable }
}
