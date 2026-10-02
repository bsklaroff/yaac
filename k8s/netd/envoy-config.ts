/**
 * Renders the Envoy config netd hands to a co-located stock Envoy through
 * file-based xDS: the listeners and clusters of an LDS and a CDS document
 * that Envoy hot-reloads. All functions here are pure; netd.ts writes the
 * files.
 *
 * Each install has three listeners (https, http, tunnel), each forwarding
 * to one cluster aimed at the install's proxy. Key settings:
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

/** A listener or cluster, as it goes into a DiscoveryResponse. */
export interface EnvoyResource {
  name: string
  [key: string]: unknown
}

/**
 * The name of one leg's listener and of the cluster it forwards to (Envoy
 * keeps listener and cluster names apart). Sanitized to `[a-z0-9-]` so
 * Envoy's stat sinks never see a mangled name.
 */
export function resourceName(installNamespace: string, leg: TrioLeg): string {
  const ns = installNamespace.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `yaac-${ns}-${leg}`
}

export interface LdsInput {
  installNamespace: string
  trio: ListenerTrio
  /** Source IPs of the pods to redirect. */
  podIps: string[]
}

export interface CdsInput {
  installNamespace: string
  /** The proxy Service's ClusterIP, or null when it is not up yet. */
  proxyIp: string | null
  transparentPorts: TransparentPorts
}

function listenerResource(name: string, port: number, podIps: string[]): EnvoyResource {
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
    filter_chains: [{
      filter_chain_match: {
        source_prefix_ranges: podIps.map((ip) => ({ address_prefix: ip, prefix_len: 32 })),
      },
      filters: [{
        name: 'envoy.filters.network.tcp_proxy',
        typed_config: {
          '@type': 'type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy',
          stat_prefix: name,
          cluster: name,
        },
      }],
    }],
  }
}

function clusterResource(name: string, ip: string, port: number): EnvoyResource {
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
 * The listeners for the given pods, one per leg. None when there is no
 * pod, since a listener with no filter chains is invalid; the trio's ports
 * stay reserved either way. IPs are deduplicated and sorted so an
 * unchanged pod set renders identical bytes.
 */
export function renderLds(input: LdsInput): EnvoyResource[] {
  const podIps = [...new Set(input.podIps)].sort()
  if (podIps.length === 0) return []
  return LEGS.map((leg) => listenerResource(
    resourceName(input.installNamespace, leg), input.trio[leg], podIps,
  ))
}

/** The clusters aimed at the proxy, one per leg; none until it is up. */
export function renderCds(input: CdsInput): EnvoyResource[] {
  const { proxyIp } = input
  if (!proxyIp) return []
  return LEGS.map((leg) => clusterResource(
    resourceName(input.installNamespace, leg), proxyIp, input.transparentPorts[leg],
  ))
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
