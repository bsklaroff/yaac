/**
 * The cluster addresses network policies use: node `/32`s (the host network
 * namespace) and pod CIDRs (in-cluster rather than external traffic).
 *
 * An empty or narrow set fails silently, either denying the redirect path or
 * sending pod-to-pod traffic into the proxy, so these tests cover refusals
 * and reporting as well as the happy path.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { apiError, fakeCluster } from '@yaac/test-utils/k8s-stub'
import { nodeIpBlocks, podCidrSources, resetClusterCidrCache } from '#drivers/k8s/cluster'

const node = (ip: string, annotations?: Record<string, string>) => ({
  apiVersion: 'v1',
  kind: 'Node',
  metadata: { name: `node-${ip}`, ...(annotations ? { annotations } : {}) },
  status: { addresses: [{ type: 'InternalIP', address: ip }] },
})
const ipPool = (cidr: string) => ({
  apiVersion: 'crd.projectcalico.org/v1', kind: 'IPPool', metadata: { name: cidr.replace(/\W/g, '-') }, spec: { cidr },
})

beforeEach(() => {
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
    fakeCluster.seed(
      node('10.89.0.21', { 'projectcalico.org/IPv4IPIPTunnelAddr': '10.244.93.192' }),
      node('10.89.0.20', { 'projectcalico.org/IPv4VXLANTunnelAddr': '10.244.86.128' }),
      // A node without a tunnel annotation yet still contributes its
      // InternalIP.
      node('10.89.0.19'),
    )

    await expect(nodeIpBlocks()).resolves.toEqual([
      '10.244.86.128/32', '10.244.93.192/32',
      '10.89.0.19/32', '10.89.0.20/32', '10.89.0.21/32',
    ])
  })

  it('throws rather than answering empty when no address resolves', async () => {
    // An empty ipBlock set would silently cut every workspace's egress.
    await expect(nodeIpBlocks()).rejects.toThrow(/could not resolve any node InternalIP/)
  })

  it('caches the answer, and the reset hook is what lets a rebuild change it', async () => {
    fakeCluster.seed(node('10.89.0.7'))
    await expect(nodeIpBlocks()).resolves.toEqual(['10.89.0.7/32'])
    await nodeIpBlocks()
    expect(fakeCluster.callsOf('list', 'Node')).toHaveLength(1)

    // Addresses change only on a cluster rebuild. A process that outlives
    // one must reset, or every policy would name the old addresses.
    fakeCluster.reset()
    fakeCluster.seed(node('10.89.0.9'))
    await expect(nodeIpBlocks()).resolves.toEqual(['10.89.0.7/32'])
    resetClusterCidrCache()
    await expect(nodeIpBlocks()).resolves.toEqual(['10.89.0.9/32'])
  })
})

describe('podCidrSources', () => {
  it('reports each source separately, so a narrow set is attributable', async () => {
    fakeCluster.seed(
      ipPool('192.168.0.0/16'),
      { apiVersion: 'v1', kind: 'Node', metadata: { name: 'n1' }, spec: { podCIDR: '10.244.0.0/24' } },
    )
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
    vi.stubEnv('YAAC_POD_CIDRS', '172.31.0.0/16, 172.31/16, 10.0.0.0/33')

    const { configured, droppedConfigured } = await podCidrSources()

    expect(configured).toEqual(['172.31.0.0/16'])
    expect([...droppedConfigured].sort()).toEqual(['10.0.0.0/33', '172.31/16'])
  })

  it('separates a source that is absent from one it could not read', async () => {
    // Without Calico there is no IPPool CRD, which is fine. An RBAC denial
    // on ippools would silently narrow the set, so it is reported.
    fakeCluster.removeKind('IPPool')
    expect((await podCidrSources()).unreadable).toEqual([])

    fakeCluster.reset()
    fakeCluster.intercept((call) => {
      if (call.kind === 'IPPool') throw apiError(403, 'ippools is forbidden')
    })
    const { unreadable } = await podCidrSources()
    expect(unreadable).toHaveLength(1)
    expect(unreadable[0].source).toMatch(/ippool/i)
  })
})
