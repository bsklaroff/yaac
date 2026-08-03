import { kubectlGetJson } from '#platform/k8s'

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
  items?: Array<{ status?: { addresses?: Array<{ type?: string; address?: string }> } }>
}

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
 * redirect delivery path, which presents as "all sessions lost egress"
 * with no obvious cause.
 */
export async function nodeIpBlocks(): Promise<string[]> {
  if (nodeCidrCache) return nodeCidrCache
  const list = await kubectlGetJson<RawNodeList>(['get', 'nodes'])
  const cidrs = (list?.items ?? [])
    .flatMap((n) => n.status?.addresses ?? [])
    .filter((a) => a.type === 'InternalIP' && a.address)
    .map((a) => `${a.address!}/32`)
  const unique = [...new Set(cidrs)].sort()
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

/** A dotted-quad CIDR, which is all the v4 nat rules can express. */
function isIpv4Cidr(value: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(value)
}

function normalize(cidrs: string[]): string[] {
  return [...new Set(cidrs.filter(isIpv4Cidr))].sort()
}

/**
 * Every CIDR the cluster allocates pod IPs from — netd's exclusion list,
 * which is what keeps pod-to-pod traffic out of the redirect.
 *
 * Sourced in preference order, because no single source is right
 * everywhere:
 *
 *  1. **Calico IPPools.** The authority wherever Calico does the IPAM,
 *     which is every cluster `yaac cluster setup` builds. Calico allocates
 *     /26 blocks from anywhere in its pool, so a pod's IP routinely falls
 *     outside its own node's `spec.podCIDR` — that field describes the
 *     kubeadm allocation Calico is not using.
 *  2. **`spec.podCIDR` across ALL nodes.** For clusters whose CNI does use
 *     the kubeadm per-node allocation. Every node, not the first one: on a
 *     multi-node cluster each holds a different slice.
 *  3. **kind's default.** Only when the cluster publishes neither, which
 *     no cluster yaac installs into does.
 *
 * Too NARROW is the dangerous direction — a pod IP outside the list is
 * treated as world and its pod-to-pod 443/80 gets redirected into the
 * proxy — so this unions its sources rather than picking a winner, and
 * never widens a CIDR it was given.
 */
export async function clusterPodCidrs(): Promise<string[]> {
  if (podCidrCache) return podCidrCache

  // `ippools` is a Calico CRD; on a cluster without Calico the get fails,
  // which is a missing source and not an error.
  const pools = await kubectlGetJson<RawIpPoolList>([
    'get', 'ippools.crd.projectcalico.org',
  ]).catch(() => null)
  const poolCidrs = normalize((pools?.items ?? [])
    .filter((p) => p.spec?.disabled !== true)
    .map((p) => p.spec?.cidr ?? ''))

  const nodes = await kubectlGetJson<RawPodCidrNodeList>(['get', 'nodes']).catch(() => null)
  const nodeCidrs = normalize((nodes?.items ?? [])
    .flatMap((n) => [n.spec?.podCIDR ?? '', ...(n.spec?.podCIDRs ?? [])]))

  const resolved = normalize([...poolCidrs, ...nodeCidrs])
  podCidrCache = resolved.length > 0 ? resolved : [FALLBACK_POD_CIDR]
  return podCidrCache
}
