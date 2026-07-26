import { describe, expect, it } from 'vitest'
import {
  type FilterChainSpec,
  groupChains,
  ldsListenerNames,
  listenerName,
  renderBootstrap,
  renderCds,
  renderLds,
  resourceName,
} from 'yaac-netd/envoy-config'
import type { EgressTarget, PodTarget } from 'yaac-netd/targets'
import type { ListenerTrio } from 'yaac-netd/ports'

const TRIO: ListenerTrio = { https: 15100, http: 15101, tunnel: 15102 }
const TARGETS: EgressTarget[] = [{ key: 'outer/yaac', ip: '10.96.0.50' }]
const CHAINS: FilterChainSpec[] = [{ targetKey: 'outer/yaac', podIps: ['10.244.0.9'] }]
const PORTS = { https: 10256, http: 10257, tunnel: 10258 }
const LDS = { installNamespace: 'yaac', trio: TRIO, chains: CHAINS, versionInfo: 'v1' }
const CDS = { targets: TARGETS, transparentPorts: PORTS, versionInfo: 'v1' }

interface Resource { '@type': string; name: string; [k: string]: unknown }
interface Chain {
  name: string
  filter_chain_match: { source_prefix_ranges: Array<{ address_prefix: string; prefix_len: number }> }
  filters: Array<{ typed_config: { cluster: string } }>
}
const resources = (doc: Record<string, unknown>): Resource[] => doc.resources as Resource[]
const chainsOf = (r: Resource): Chain[] => r.filter_chains as Chain[]
const portOf = (r: Resource): number =>
  (r.address as { socket_address: { port_value: number } }).socket_address.port_value

const pod = (name: string, podIp: string, key: string): PodTarget => ({
  pod: { name, namespace: 'yaac', podIp, labels: {} },
  target: { key, ip: '10.96.0.50' },
})

describe('resourceName', () => {
  it('sanitizes a target key into an Envoy-safe cluster name', () => {
    expect(resourceName('inner/yaac-vc-abc/hash1', 'https')).toBe('yaac-inner-yaac-vc-abc-hash1-https')
  })

  it('collapses separators and never leaves a leading or trailing dash', () => {
    expect(resourceName('//weird__key//', 'http')).toBe('yaac-weird-key-http')
  })
})

describe('listenerName', () => {
  it('scopes the listener to the install, not to a target', () => {
    expect(listenerName('yaac-test-abc', 'https')).toBe('yaac-listener-yaac-test-abc-https')
  })
})

describe('groupChains', () => {
  it('gathers every pod of a target into one chain, sorted', () => {
    const chains = groupChains([
      pod('b', '10.244.0.20', 'outer/yaac'),
      pod('a', '10.244.0.9', 'outer/yaac'),
    ])
    expect(chains).toEqual([{ targetKey: 'outer/yaac', podIps: ['10.244.0.20', '10.244.0.9'] }])
  })

  it('is byte-stable regardless of selection order', () => {
    // The no-op-write memo and the version stamp the listener gate waits
    // on both depend on this.
    const a = groupChains([pod('a', '10.244.0.9', 'outer/yaac'), pod('b', '10.244.0.10', 'inner/x/h')])
    const b = groupChains([pod('b', '10.244.0.10', 'inner/x/h'), pod('a', '10.244.0.9', 'outer/yaac')])
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('dedupes a pod IP reused after a pod was replaced', () => {
    const chains = groupChains([pod('a', '10.244.0.9', 'outer/yaac'), pod('b', '10.244.0.9', 'outer/yaac')])
    expect(chains[0]?.podIps).toEqual(['10.244.0.9'])
  })

  it('returns nothing for an empty selection', () => {
    expect(groupChains([])).toEqual([])
  })
})

describe('renderLds', () => {
  it('renders exactly three listeners — one per leg of the install trio', () => {
    const list = resources(renderLds(LDS))
    expect(list.map((r) => r.name)).toEqual([
      'yaac-listener-yaac-https', 'yaac-listener-yaac-http', 'yaac-listener-yaac-tunnel',
    ])
    expect(list.map(portOf)).toEqual([15100, 15101, 15102])
  })

  it('routes to a target by SOURCE pod IP, not by listener port', () => {
    // This is what lets every target share one trio, so a target coming or
    // going never moves a port out from under a live flow.
    const chains: FilterChainSpec[] = [
      { targetKey: 'inner/yaac-vc-a/h1', podIps: ['10.244.0.20'] },
      { targetKey: 'outer/yaac', podIps: ['10.244.0.9', '10.244.0.10'] },
    ]
    const https = resources(renderLds({ ...LDS, chains }))[0]
    expect(portOf(https)).toBe(15100)
    expect(chainsOf(https).map((c) => c.filters[0].typed_config.cluster)).toEqual([
      'yaac-inner-yaac-vc-a-h1-https', 'yaac-outer-yaac-https',
    ])
    expect(chainsOf(https)[1].filter_chain_match.source_prefix_ranges).toEqual([
      { address_prefix: '10.244.0.9', prefix_len: 32 },
      { address_prefix: '10.244.0.10', prefix_len: 32 },
    ])
  })

  it('has no default filter chain, so an unprogrammed source is closed', () => {
    const doc = renderLds(LDS)
    expect(JSON.stringify(doc)).not.toContain('default_filter_chain')
  })

  it('disables reuse_port so a cross-install collision fails loudly', () => {
    // Envoy defaults it to true; two hostNetwork Envoys as the same uid
    // would then BOTH bind the trio and the kernel would split
    // connections between them — silent cross-install misrouting.
    for (const r of resources(renderLds(LDS))) expect(r.enable_reuse_port).toBe(false)
  })

  it('installs the original_dst listener filter on every listener', () => {
    // Load-bearing: the rule DNATs to this listener, so the pre-DNAT
    // destination only survives via SO_ORIGINAL_DST.
    for (const r of resources(renderLds(LDS))) {
      const filters = r.listener_filters as Array<{ name: string }>
      expect(filters[0].name).toBe('envoy.filters.listener.original_dst')
    }
  })

  it('renders no listener at all when no pod is programmed', () => {
    // A listener with empty filter_chains is invalid config, and there is
    // nothing to serve anyway.
    expect(resources(renderLds({ ...LDS, chains: [] }))).toEqual([])
    expect(resources(renderLds({ ...LDS, chains: [{ targetKey: 'outer/yaac', podIps: [] }] })))
      .toEqual([])
  })

  it('carries the version stamp Envoy uses to detect a change', () => {
    expect(renderLds(LDS).version_info).toBe('v1')
  })
})

describe('ldsListenerNames', () => {
  it('names the three listeners the gate must wait for', () => {
    expect(ldsListenerNames({ installNamespace: 'yaac', chains: CHAINS })).toEqual([
      'yaac-listener-yaac-https', 'yaac-listener-yaac-http', 'yaac-listener-yaac-tunnel',
    ])
  })

  it('expects nothing when the document declares no listener', () => {
    expect(ldsListenerNames({ installNamespace: 'yaac', chains: [] })).toEqual([])
  })
})

describe('renderCds', () => {
  it('renders a STATIC cluster per leg aimed at the proxy ClusterIP', () => {
    const list = resources(renderCds(CDS))
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
    // This is what carries pod identity to the proxy; without it the
    // proxy cannot attribute a connection to a session at all.
    for (const r of resources(renderCds(CDS))) {
      const ts = r.transport_socket as { name: string; typed_config: { config: { version: string } } }
      expect(ts.name).toBe('envoy.transport_sockets.upstream_proxy_protocol')
      expect(ts.typed_config.config.version).toBe('V2')
    }
  })

  it('renders a distinct cluster per target', () => {
    const targets: EgressTarget[] = [
      { key: 'outer/yaac', ip: '10.96.0.50' },
      { key: 'inner/vc/h', ip: '10.96.0.77' },
    ]
    const list = resources(renderCds({ ...CDS, targets }))
    expect(list).toHaveLength(6)
    expect(new Set(list.map((r) => r.name)).size).toBe(6)
  })

  it('names clusters exactly as the listener filter chains reference them', () => {
    const names = new Set(resources(renderCds(CDS)).map((r) => r.name))
    for (const listener of resources(renderLds(LDS))) {
      for (const chain of chainsOf(listener)) {
        expect(names).toContain(chain.filters[0].typed_config.cluster)
      }
    }
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
    // A unix socket, not a port: these Envoys are hostNetwork and several
    // installs share a node, so any fixed loopback port collides and the
    // second Envoy dies before serving anything. netd shares the volume,
    // so it is also how the listener gate reads Envoy's state.
    const admin = b.admin as { address: { pipe?: { path: string }; socket_address?: unknown } }
    expect(admin.address.pipe).toEqual({ path: '/e/admin.sock' })
    expect(admin.address.socket_address).toBeUndefined()
  })

  it('declares no static listeners or clusters — netd owns the whole datapath', () => {
    expect(renderBootstrap({ ldsPath: 'l', cdsPath: 'c', adminPath: 'a' }).static_resources).toBeUndefined()
  })
})
