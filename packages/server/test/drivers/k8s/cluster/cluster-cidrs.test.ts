/**
 * The cluster addresses network policies use: node `/32`s (the host network
 * namespace) and pod CIDRs (in-cluster rather than external traffic).
 *
 * An empty or narrow set fails silently, either denying the redirect path or
 * sending pod-to-pod traffic into the proxy, so these tests cover refusals
 * and reporting as well as the happy path.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import type * as kubectlModule from '#drivers/k8s/substrate/kubectl'

const mockKubectlGetJson = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/substrate/kubectl', async (importOriginal) => ({
  ...(await importOriginal<typeof kubectlModule>()),
  kubectlGetJson: mockKubectlGetJson,
}))

import { nodeIpBlocks, podCidrSources, resetClusterCidrCache } from '#drivers/k8s/cluster'

const node = (ip: string, annotations?: Record<string, string>) => ({
  metadata: annotations ? { annotations } : {},
  status: { addresses: [{ type: 'InternalIP', address: ip }] },
})

beforeEach(() => {
  vi.clearAllMocks()
  resetClusterCidrCache()
})

afterEach(() => {
  vi.unstubAllEnvs()
  resetClusterCidrCache()
})

describe('nodeIpBlocks', () => {
  it('names every node by InternalIP and by overlay tunnel address', async () => {
    // Calico sends host traffic to a pod on another node from the tunnel
    // address, not the InternalIP. Without it, netd's Envoy is dropped on
    // cross-node hops, which never shows on a single node.
    mockKubectlGetJson.mockResolvedValue({
      items: [
        node('10.89.0.21', { 'projectcalico.org/IPv4IPIPTunnelAddr': '10.244.93.192' }),
        node('10.89.0.20', { 'projectcalico.org/IPv4VXLANTunnelAddr': '10.244.86.128' }),
        // A node without a tunnel annotation yet still contributes its
        // InternalIP.
        node('10.89.0.19'),
      ],
    })

    await expect(nodeIpBlocks()).resolves.toEqual([
      '10.244.86.128/32', '10.244.93.192/32',
      '10.89.0.19/32', '10.89.0.20/32', '10.89.0.21/32',
    ])
  })

  it('throws rather than answering empty when no address resolves', async () => {
    // An empty ipBlock set would silently cut every workspace's egress.
    mockKubectlGetJson.mockResolvedValue({ items: [] })
    await expect(nodeIpBlocks()).rejects.toThrow(/could not resolve any node InternalIP/)
  })

  it('caches the answer, and the reset hook is what lets a rebuild change it', async () => {
    mockKubectlGetJson.mockResolvedValue({ items: [node('10.89.0.7')] })
    await expect(nodeIpBlocks()).resolves.toEqual(['10.89.0.7/32'])
    await nodeIpBlocks()
    expect(mockKubectlGetJson).toHaveBeenCalledOnce()

    // Addresses change only on a cluster rebuild. A process that outlives
    // one must reset, or every policy would name the old addresses.
    mockKubectlGetJson.mockResolvedValue({ items: [node('10.89.0.9')] })
    await expect(nodeIpBlocks()).resolves.toEqual(['10.89.0.7/32'])
    resetClusterCidrCache()
    await expect(nodeIpBlocks()).resolves.toEqual(['10.89.0.9/32'])
  })
})

describe('podCidrSources', () => {
  /** Serve Calico's IPPools and the nodes' podCIDRs; anything else absent. */
  function staged(opts: { pools?: unknown; nodes?: unknown; fail?: string } = {}): void {
    mockKubectlGetJson.mockImplementation((args: string[]) => {
      const which = args[1] ?? ''
      if (opts.fail && which.startsWith(opts.fail)) {
        return Promise.reject(Object.assign(new Error('exit 1'), {
          stderr: 'Error from server (Forbidden): ippools is forbidden',
        }))
      }
      if (which.startsWith('ippools')) {
        return opts.pools === undefined
          ? Promise.reject(new Error('Error from server (NotFound)'))
          : Promise.resolve(opts.pools)
      }
      if (which === 'nodes') return Promise.resolve(opts.nodes ?? { items: [] })
      return Promise.resolve(null)
    })
  }

  it('reports each source separately, so a narrow set is attributable', async () => {
    staged({
      pools: { items: [{ spec: { cidr: '192.168.0.0/16' } }] },
      nodes: { items: [{ spec: { podCIDR: '10.244.0.0/24' } }] },
    })
    vi.stubEnv('YAAC_POD_CIDRS', '172.31.0.0/16')

    const { configured, pools, nodes, droppedConfigured, unreadable } = await podCidrSources()

    expect(configured).toEqual(['172.31.0.0/16'])
    expect(pools).toEqual(['192.168.0.0/16'])
    expect(nodes).toEqual(['10.244.0.0/24'])
    expect(droppedConfigured).toEqual([])
    expect(unreadable).toEqual([])
  })

  it('reports an unusable configured entry rather than dropping it', async () => {
    // Silently dropping a typo'd entry would narrow the exclusion set and
    // redirect those pods into the proxy.
    staged({ pools: { items: [] } })
    vi.stubEnv('YAAC_POD_CIDRS', '172.31.0.0/16, 172.31/16, 10.0.0.0/33')

    const { configured, droppedConfigured } = await podCidrSources()

    expect(configured).toEqual(['172.31.0.0/16'])
    expect([...droppedConfigured].sort()).toEqual(['10.0.0.0/33', '172.31/16'])
  })

  it('separates a source that is absent from one it could not read', async () => {
    // Without Calico there is no IPPool CRD, which is fine. An RBAC denial
    // on ippools would silently narrow the set, so it is reported.
    staged({ pools: { items: [] } })
    expect((await podCidrSources()).unreadable).toEqual([])

    staged({ fail: 'ippools' })
    const { unreadable } = await podCidrSources()
    expect(unreadable).toHaveLength(1)
    expect(unreadable[0].source).toMatch(/ippool/i)
  })
})
