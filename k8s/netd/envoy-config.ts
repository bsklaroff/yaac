/**
 * Envoy configuration rendering.
 *
 * netd drives a co-located stock Envoy through file-based xDS: it writes
 * an LDS and a CDS document, and Envoy hot-reloads them — no restarts, no
 * control-plane gRPC, no custom forwarder code. Everything here is pure
 * (desired state in, config documents out); the writer does the atomic
 * rename.
 *
 * THREE listeners per install, one per leg, and one cluster per egress
 * target per leg. A connection's target is chosen by its SOURCE, not by
 * the port it arrived on:
 *
 *   listener :H ──source 10.244.0.9/32 ──▶ cluster outer  ──PP2──▶ ip:10256
 *              └─source 10.244.0.14/32 ──▶ cluster inner/… ──PP2──▶ ip:10256
 *
 * Four things are load-bearing:
 *
 * - `original_dst` listener filter. The per-pod rule DNATs the packet to
 *   this listener, so the socket's own local address is the node, not the
 *   host the workload asked for. The filter recovers the pre-DNAT
 *   destination from conntrack (SO_ORIGINAL_DST) and installs it as the
 *   connection's local address, which is what the PROXY-protocol header
 *   below then carries. Without it the proxy would learn only that
 *   *something* was redirected, losing the target the allowlist is
 *   evaluated against for non-TLS/non-HTTP flows.
 * - `filter_chain_match.source_prefix_ranges`. Routing on the source pod
 *   IP is what lets every target share one listener trio, so a target
 *   appearing or leaving never moves a port out from under a live flow.
 *   Matching is exact-prefix per pod, and there is deliberately NO
 *   `default_filter_chain`: a source netd has not programmed matches
 *   nothing and Envoy closes the connection, which is the same
 *   fail-closed direction as a missing DNAT rule.
 * - `proxy_protocol` upstream transport (V2). Envoy stamps the downstream
 *   connection's real source and (post-`original_dst`) original
 *   destination. The proxy parses it with k8s/proxy/pp2.ts and resolves
 *   source IP → worktree. It stamps the address it OBSERVES, so a pod that
 *   dials a listener directly cannot claim to be another pod.
 * - `enable_reuse_port: false`. Envoy's default is true, and several
 *   installs run hostNetwork Envoys in one netns as the same uid — with
 *   the default, two installs that chose the same trio would BOTH bind it
 *   and the kernel would split connections between them, which is silent
 *   cross-install misrouting. Disabled, the loser fails to bind, netd's
 *   listener gate sees the rejection, and it re-probes for a free trio.
 *
 * Clusters are plain STATIC endpoints on the target proxy's address, which
 * Envoy dials from the node root netns. For the OUTER proxy that address is
 * a ClusterIP (kube-proxy's DNAT applies normally); for a CLAIMED inner
 * proxy it is a pod IP, deliberately — see the invariant in targets.ts.
 */

import type { EgressTarget, PodTarget } from 'yaac-netd/targets'
import type { ListenerTrio } from 'yaac-netd/ports'

/** Which of the three legs a rendered resource serves. */
export type TrioLeg = 'https' | 'http' | 'tunnel'

/** The proxy-side ports each leg forwards to (from proxy-constants.ts). */
export interface TransparentPorts {
  https: number
  http: number
  tunnel: number
}

export const LEGS: TrioLeg[] = ['https', 'http', 'tunnel']

/** Sanitize to `[a-z0-9-]` so Envoy's stat sinks never see a mangled name. */
function sanitize(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** Envoy cluster name for one leg of one egress target. */
export function resourceName(targetKey: string, leg: TrioLeg): string {
  return `yaac-${sanitize(targetKey)}-${leg}`
}

/** Envoy listener name for one leg of this install's trio. */
export function listenerName(installNamespace: string, leg: TrioLeg): string {
  return `yaac-listener-${sanitize(installNamespace)}-${leg}`
}

/** One target's share of a listener: the pod IPs whose flows it serves. */
export interface FilterChainSpec {
  targetKey: string
  /** Source pod IPs, sorted — byte-stability of the document depends on it. */
  podIps: string[]
}

/**
 * Group a selection into one filter chain per egress target.
 *
 * Sorted at both levels (targets by key, sources by IP) so an unchanged
 * selection renders byte-identical documents pass after pass — the memo
 * that suppresses no-op writes, and the version stamp the listener gate
 * waits on, both depend on that.
 */
export function groupChains(selected: PodTarget[]): FilterChainSpec[] {
  const byKey = new Map<string, Set<string>>()
  for (const { pod, target } of selected) {
    const ips = byKey.get(target.key) ?? new Set<string>()
    ips.add(pod.podIp)
    byKey.set(target.key, ips)
  }
  return [...byKey.entries()]
    .map(([targetKey, ips]) => ({ targetKey, podIps: [...ips].sort() }))
    .sort((a, b) => (a.targetKey < b.targetKey ? -1 : a.targetKey > b.targetKey ? 1 : 0))
}

export interface LdsInput {
  installNamespace: string
  trio: ListenerTrio
  chains: FilterChainSpec[]
  /**
   * Opaque version stamp Envoy uses to decide a document changed. netd
   * passes a hash of the rendered content, so an unchanged reconcile is a
   * genuine no-op for Envoy even if the file is rewritten — and the same
   * stamp is what the listener gate waits to see acknowledged.
   */
  versionInfo: string
}

export interface CdsInput {
  targets: EgressTarget[]
  transparentPorts: TransparentPorts
  versionInfo: string
}

function filterChain(spec: FilterChainSpec, leg: TrioLeg): Record<string, unknown> {
  const cluster = resourceName(spec.targetKey, leg)
  return {
    name: cluster,
    filter_chain_match: {
      source_prefix_ranges: spec.podIps.map((ip) => ({ address_prefix: ip, prefix_len: 32 })),
    },
    filters: [{
      name: 'envoy.filters.network.tcp_proxy',
      typed_config: {
        '@type': 'type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy',
        stat_prefix: cluster,
        cluster,
      },
    }],
  }
}

function listenerResource(
  name: string,
  port: number,
  chains: FilterChainSpec[],
  leg: TrioLeg,
): Record<string, unknown> {
  return {
    '@type': 'type.googleapis.com/envoy.config.listener.v3.Listener',
    name,
    address: { socket_address: { address: '0.0.0.0', port_value: port } },
    enable_reuse_port: false,
    listener_filters: [{
      name: 'envoy.filters.listener.original_dst',
      typed_config: {
        '@type': 'type.googleapis.com/envoy.extensions.filters.listener.original_dst.v3.OriginalDst',
      },
    }],
    filter_chains: chains.map((chain) => filterChain(chain, leg)),
  }
}

function clusterResource(
  name: string,
  ip: string,
  port: number,
): Record<string, unknown> {
  return {
    '@type': 'type.googleapis.com/envoy.config.cluster.v3.Cluster',
    name,
    connect_timeout: '5s',
    type: 'STATIC',
    load_assignment: {
      cluster_name: name,
      endpoints: [{
        lb_endpoints: [{
          endpoint: { address: { socket_address: { address: ip, port_value: port } } },
        }],
      }],
    },
    transport_socket: {
      name: 'envoy.transport_sockets.upstream_proxy_protocol',
      typed_config: {
        '@type': 'type.googleapis.com/envoy.extensions.transport_sockets.proxy_protocol.v3.ProxyProtocolUpstreamTransport',
        config: { version: 'V2' },
        transport_socket: {
          name: 'envoy.transport_sockets.raw_buffer',
          typed_config: {
            '@type': 'type.googleapis.com/envoy.extensions.transport_sockets.raw_buffer.v3.RawBuffer',
          },
        },
      },
    },
  }
}

/**
 * The LDS document (a DiscoveryResponse) for the current selection.
 *
 * Renders nothing at all when no pod is programmed: a listener with an
 * empty `filter_chains` is invalid config, and with no pods there is
 * nothing to serve anyway. The trio stays reserved regardless — the
 * allocator holds the slot for the netd pod's lifetime.
 */
export function renderLds(input: LdsInput): Record<string, unknown> {
  const chains = input.chains.filter((c) => c.podIps.length > 0)
  const resources = chains.length === 0 ? [] : LEGS.map((leg) => listenerResource(
    listenerName(input.installNamespace, leg),
    input.trio[leg],
    chains,
    leg,
  ))
  return { version_info: input.versionInfo, resources }
}

/** The names the LDS document above declares — what the gate waits for. */
export function ldsListenerNames(input: Pick<LdsInput, 'installNamespace' | 'chains'>): string[] {
  if (input.chains.every((c) => c.podIps.length === 0)) return []
  return LEGS.map((leg) => listenerName(input.installNamespace, leg))
}

/** The CDS document (a DiscoveryResponse) for the current target set. */
export function renderCds(input: CdsInput): Record<string, unknown> {
  const resources: Record<string, unknown>[] = []
  for (const target of input.targets) {
    for (const leg of LEGS) {
      resources.push(clusterResource(
        resourceName(target.key, leg),
        target.ip,
        input.transparentPorts[leg],
      ))
    }
  }
  return { version_info: input.versionInfo, resources }
}

/**
 * The static bootstrap. Only wiring: an admin endpoint and the two
 * file-based xDS sources. Every listener and cluster is dynamic, so netd
 * owns the whole datapath surface and the image stays a stock Envoy.
 *
 * The admin endpoint is a UNIX SOCKET, not a TCP port. These Envoys run
 * with hostNetwork, and several installs share a node (the real one plus
 * an e2e run's), so any fixed loopback port is a guaranteed collision —
 * the second Envoy dies with "Address already in use" before it serves
 * anything. The socket lives in each install's own config volume, so it
 * cannot collide by construction, it is unreachable off-node for free, and
 * netd (which shares that volume) can reach it to gate on listener state.
 * Triage: `curl --unix-socket <adminPath> http://localhost/stats`.
 */
export function renderBootstrap(opts: {
  ldsPath: string
  cdsPath: string
  adminPath: string
}): Record<string, unknown> {
  return {
    admin: { address: { pipe: { path: opts.adminPath } } },
    node: { id: 'yaac-netd', cluster: 'yaac-netd' },
    dynamic_resources: {
      lds_config: { path_config_source: { path: opts.ldsPath } },
      cds_config: { path_config_source: { path: opts.cdsPath } },
    },
  }
}
