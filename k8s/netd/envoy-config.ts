/**
 * Renders the Envoy config netd hands to a co-located stock Envoy through
 * file-based xDS: an LDS and a CDS document that Envoy hot-reloads. All
 * functions here are pure; netd.ts writes the files.
 *
 * Each install has three listeners (https, http, tunnel) and one cluster
 * per egress target per leg. A connection's target is chosen by its
 * source pod IP, not by the port it arrived on. Key settings:
 *
 * - `original_dst` listener filter: recovers the pre-DNAT destination so
 *   the PROXY-protocol header can carry the host the workload dialed.
 * - `source_prefix_ranges`: one /32 per pod. There is no
 *   `default_filter_chain`, so an unprogrammed source is closed.
 * - PROXY protocol v2 upstream: Envoy stamps the observed source and
 *   original destination; the proxy parses it (k8s/proxy/pp2.ts) to find
 *   the workspace. A pod cannot spoof another pod's source.
 * - `enable_reuse_port: false`: otherwise two installs that picked the
 *   same ports would both bind them and the kernel would split traffic.
 *   With it off, the second bind fails and netd picks another trio.
 *
 * Clusters are STATIC endpoints on the proxy's ClusterIP. See
 * docs/workspace-egress.md.
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
  /** Source pod IPs, sorted so the rendered document is stable. */
  podIps: string[]
}

/**
 * Group a selection into one filter chain per egress target. Both levels
 * are sorted so an unchanged selection renders identical bytes, which the
 * no-op write check and the version stamp rely on.
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
   * Version stamp for the document. netd passes a hash of the rendered
   * content; the listener gate waits for Envoy to report this version.
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
 * The LDS document (a DiscoveryResponse) for the current selection. Empty
 * when no pod is programmed, since a listener with no filter chains is
 * invalid. The trio's ports stay reserved either way.
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

/** Listener names renderLds declares, for the listener gate. */
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
 * The static bootstrap: an admin endpoint and the two file-based xDS
 * sources. All listeners and clusters are dynamic.
 *
 * The admin endpoint is a unix socket in the install's config volume, not
 * a TCP port, because several installs' hostNetwork Envoys can share a
 * node and a fixed port would collide. Debug with
 * `curl --unix-socket <adminPath> http://localhost/stats`.
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
