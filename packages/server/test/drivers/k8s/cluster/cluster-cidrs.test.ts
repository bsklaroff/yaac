/**
 * The cluster addresses network policies use: node `/32`s (the host network
 * namespace), the DNS Service's and the apiserver's real endpoints.
 *
 * An empty set fails silently, cutting off what it should admit, so these
 * tests cover refusals as well as the happy path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fakeCluster } from '@yaac/test-utils/k8s-stub'
import {
  apiserverEndpoints, nodeAddressBlocks, nodeIpBlocks, resetClusterCidrCache,
} from '#drivers/k8s/cluster'

const node = (ip: string, annotations?: Record<string, string>) => ({
  apiVersion: 'v1',
  kind: 'Node',
  metadata: { name: `node-${ip}`, ...(annotations ? { annotations } : {}) },
  status: { addresses: [{ type: 'InternalIP', address: ip }] },
})

beforeEach(() => {
  resetClusterCidrCache()
})

afterEach(() => {
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

describe('nodeAddressBlocks', () => {
  it('adds every node\'s ExternalIPs, of either family, to the addresses nodeIpBlocks admits', async () => {
    // A byo node's public address is its ExternalIP. A builder dialing its
    // own node's is delivered locally, so the egress excepts must name it.
    fakeCluster.seed({
      ...node('10.0.1.5', { 'projectcalico.org/IPv4VXLANTunnelAddr': '10.244.86.128' }),
      status: {
        addresses: [
          { type: 'InternalIP', address: '10.0.1.5' },
          { type: 'ExternalIP', address: '5.75.1.9' },
          { type: 'ExternalIP', address: '2a01:4f8:1c1c::1' },
          { type: 'Hostname', address: 'node-a' },
        ],
      },
    })

    await expect(nodeAddressBlocks()).resolves.toEqual([
      '10.0.1.5/32', '10.244.86.128/32', '2a01:4f8:1c1c::1/128', '5.75.1.9/32',
    ])
    // The admitted set stays the InternalIP and tunnel address.
    await expect(nodeIpBlocks()).resolves.toEqual(['10.0.1.5/32', '10.244.86.128/32'])
    expect(fakeCluster.callsOf('list', 'Node')).toHaveLength(1)
  })
})

describe('apiserverEndpoints', () => {
  it('reads the apiserver\'s real endpoints, of either family, from the kubernetes Service\'s slices', async () => {
    // Policy sees a destination after kube-proxy's DNAT, so the proxy's and
    // the server's egress must name these rather than the Service address.
    const slice = (name: string, addressType: string, addresses: string[], port: number) => ({
      apiVersion: 'discovery.k8s.io/v1', kind: 'EndpointSlice', addressType,
      metadata: { name, namespace: 'default', labels: { 'kubernetes.io/service-name': 'kubernetes' } },
      endpoints: [{ addresses }], ports: [{ port }],
    })
    fakeCluster.seed(
      slice('kubernetes', 'IPv4', ['172.18.0.3', '172.18.0.2'], 6443),
      slice('kubernetes-v6', 'IPv6', ['fd00::2'], 6443),
      // Another Service's slice in the same namespace is not the apiserver.
      { ...slice('other', 'IPv4', ['10.0.0.9'], 80), metadata: { name: 'other', namespace: 'default', labels: { 'kubernetes.io/service-name': 'other' } } },
    )
    await expect(apiserverEndpoints()).resolves.toEqual({
      cidrs: ['172.18.0.2/32', '172.18.0.3/32', 'fd00::2/128'], ports: [6443],
    })
  })
})
