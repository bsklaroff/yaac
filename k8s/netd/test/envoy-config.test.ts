import { describe, expect, it } from 'vitest'
import {
  renderBootstrap,
  renderCds,
  renderLds,
  resourceName,
  type EnvoyResource,
} from 'yaac-netd/envoy-config'
import type { ListenerTrio } from 'yaac-netd/ports'

const TRIO: ListenerTrio = { https: 15100, http: 15101, tunnel: 15102 }
const PORTS = { https: 10256, http: 10257, tunnel: 10258 }
const LDS = { installNamespace: 'yaac', trio: TRIO, podIps: ['10.244.0.9'] }
const CDS = { installNamespace: 'yaac', proxyIp: '10.96.0.50', transparentPorts: PORTS }

interface Chain {
  filter_chain_match: { source_prefix_ranges: Array<{ address_prefix: string; prefix_len: number }> }
  filters: Array<{ typed_config: { cluster: string } }>
}
const chainsOf = (r: EnvoyResource): Chain[] => r.filter_chains as Chain[]
const portOf = (r: EnvoyResource): number =>
  (r.address as { socket_address: { port_value: number } }).socket_address.port_value

describe('resourceName', () => {
  it('scopes the name to the install and sanitizes it for Envoy', () => {
    expect(resourceName('yaac-test-abc123', 'https')).toBe('yaac-yaac-test-abc123-https')
    expect(resourceName('//Weird__ns//', 'http')).toBe('yaac-weird-ns-http')
  })
})

describe('renderLds', () => {
  it('renders exactly three listeners — one per leg of the install trio', () => {
    const list = renderLds(LDS)
    expect(list.map((r) => r.name)).toEqual(['yaac-yaac-https', 'yaac-yaac-http', 'yaac-yaac-tunnel'])
    expect(list.map(portOf)).toEqual([15100, 15101, 15102])
  })

  it('admits exactly the given source pod IPs, deduped and byte-stable', () => {
    // A replaced pod can briefly share its IP with its successor.
    const a = renderLds({ ...LDS, podIps: ['10.244.0.9', '10.244.0.10', '10.244.0.9'] })
    const b = renderLds({ ...LDS, podIps: ['10.244.0.10', '10.244.0.9'] })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    const chains = chainsOf(a[0])
    expect(chains).toHaveLength(1)
    expect(chains[0].filter_chain_match.source_prefix_ranges).toEqual([
      { address_prefix: '10.244.0.10', prefix_len: 32 },
      { address_prefix: '10.244.0.9', prefix_len: 32 },
    ])
  })

  it('has no default filter chain, so an unprogrammed source is closed', () => {
    expect(JSON.stringify(renderLds(LDS))).not.toContain('default_filter_chain')
  })

  it('disables reuse_port so a cross-install collision fails loudly', () => {
    // Envoy's default (true) would let two installs' Envoys share a trio.
    for (const r of renderLds(LDS)) expect(r.enable_reuse_port).toBe(false)
  })

  it('installs the original_dst listener filter on every listener', () => {
    // Recovers the pre-DNAT destination via SO_ORIGINAL_DST.
    for (const r of renderLds(LDS)) {
      const filters = r.listener_filters as Array<{ name: string }>
      expect(filters[0].name).toBe('envoy.filters.listener.original_dst')
    }
  })

  it('renders no listener at all when no pod is programmed', () => {
    // A listener with no filter chains is invalid config.
    expect(renderLds({ ...LDS, podIps: [] })).toEqual([])
  })
})

describe('renderCds', () => {
  it('renders a STATIC cluster per leg aimed at the proxy ClusterIP', () => {
    const list = renderCds(CDS)
    expect(list).toHaveLength(3)
    const endpoints = list.map((r) => {
      const la = r.load_assignment as {
        endpoints: Array<{ lb_endpoints: Array<{ endpoint: { address: { socket_address: { address: string; port_value: number } } } }> }>
      }
      return la.endpoints[0].lb_endpoints[0].endpoint.address.socket_address
    })
    expect(endpoints).toEqual([
      { address: '10.96.0.50', port_value: 10256 },
      { address: '10.96.0.50', port_value: 10257 },
      { address: '10.96.0.50', port_value: 10258 },
    ])
    expect(list.every((r) => r.type === 'STATIC')).toBe(true)
  })

  it('wraps every upstream in PROXY-protocol v2', () => {
    // Carries the source pod IP, which the proxy maps to a workspace.
    for (const r of renderCds(CDS)) {
      const ts = r.transport_socket as { name: string; typed_config: { config: { version: string } } }
      expect(ts.name).toBe('envoy.transport_sockets.upstream_proxy_protocol')
      expect(ts.typed_config.config.version).toBe('V2')
    }
  })

  it('renders nothing while the proxy Service is not up', () => {
    expect(renderCds({ ...CDS, proxyIp: null })).toEqual([])
  })

  it('names clusters exactly as the listener filter chains reference them', () => {
    const names = renderCds(CDS).map((r) => r.name)
    const referenced = renderLds(LDS).map((l) => chainsOf(l)[0].filters[0].typed_config.cluster)
    expect(referenced).toEqual(names)
  })
})

describe('renderBootstrap', () => {
  it('wires both file-based xDS sources and a unix-socket admin endpoint', () => {
    const b = renderBootstrap({ ldsPath: '/e/lds.yaml', cdsPath: '/e/cds.yaml', adminPath: '/e/admin.sock' })
    const dyn = b.dynamic_resources as {
      lds_config: { path_config_source: { path: string } }
      cds_config: { path_config_source: { path: string } }
    }
    expect(dyn.lds_config.path_config_source.path).toBe('/e/lds.yaml')
    expect(dyn.cds_config.path_config_source.path).toBe('/e/cds.yaml')
    // A fixed TCP port would collide between installs on one node.
    const admin = b.admin as { address: { pipe?: { path: string }; socket_address?: unknown } }
    expect(admin.address.pipe).toEqual({ path: '/e/admin.sock' })
    expect(admin.address.socket_address).toBeUndefined()
  })

  it('declares no static listeners or clusters — netd owns the whole datapath', () => {
    expect(renderBootstrap({ ldsPath: 'l', cdsPath: 'c', adminPath: 'a' }).static_resources).toBeUndefined()
  })
})
