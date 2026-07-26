import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('#platform/k8s/kubectl', () => ({
  kubectlGetJson: vi.fn(),
}))

import { kubectlGetJson } from '#platform/k8s/kubectl'
import {
  FALLBACK_POD_CIDR,
  apiserverIpBlocks,
  clusterPodCidrs,
  nodeIpBlocks,
  resetClusterCidrCache,
} from '#features/cluster/cluster-cidrs'

const getJson = vi.mocked(kubectlGetJson)

/** Route each `kubectl get <kind>` to a canned object. */
function respond(byKind: Record<string, unknown>): void {
  getJson.mockImplementation((args: string[]) => {
    const kind = args[1] ?? ''
    return Promise.resolve(
      kind in byKind ? byKind[kind] : undefined,
    )
  })
}

const NODES = {
  items: [
    { status: { addresses: [{ type: 'InternalIP', address: '10.89.0.7' }] } },
    { status: { addresses: [{ type: 'Hostname', address: 'node-1' }] } },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  resetClusterCidrCache()
})

describe('nodeIpBlocks', () => {
  it('returns each node InternalIP as a /32', async () => {
    respond({ nodes: NODES })
    expect(await nodeIpBlocks()).toEqual(['10.89.0.7/32'])
  })

  it('dedupes and sorts, so the rendered policy is stable', async () => {
    respond({ nodes: { items: [
      { status: { addresses: [{ type: 'InternalIP', address: '10.89.0.8' }] } },
      { status: { addresses: [{ type: 'InternalIP', address: '10.89.0.7' }] } },
      { status: { addresses: [{ type: 'InternalIP', address: '10.89.0.7' }] } },
    ] } })
    expect(await nodeIpBlocks()).toEqual(['10.89.0.7/32', '10.89.0.8/32'])
  })

  it('throws rather than rendering an empty ipBlock set', async () => {
    // An empty set would silently deny the redirect delivery path, which
    // presents as "every session lost egress" with no obvious cause.
    respond({ nodes: { items: [] } })
    await expect(nodeIpBlocks()).rejects.toThrow(/InternalIP/)
  })

  it('caches — node addresses change only when the cluster is rebuilt', async () => {
    respond({ nodes: NODES })
    await nodeIpBlocks()
    await nodeIpBlocks()
    expect(getJson).toHaveBeenCalledTimes(1)
    resetClusterCidrCache()
    await nodeIpBlocks()
    expect(getJson).toHaveBeenCalledTimes(2)
  })
})

describe('apiserverIpBlocks', () => {
  it('reads the kubernetes Endpoints, not the Service VIP', async () => {
    // NetworkPolicy matches the post-DNAT destination, so a rule naming
    // the VIP would never match.
    respond({ endpoints: { subsets: [{ addresses: [{ ip: '10.89.0.7' }, { ip: '10.89.0.8' }] }] } })
    expect(await apiserverIpBlocks()).toEqual(['10.89.0.7/32', '10.89.0.8/32'])
  })

  it('falls back to the node set when the endpoint has no addresses', async () => {
    respond({ endpoints: { subsets: [] }, nodes: NODES })
    expect(await apiserverIpBlocks()).toEqual(['10.89.0.7/32'])
  })
})

describe('clusterPodCidrs', () => {
  it('prefers Calico IPPools — the authority wherever Calico does the IPAM', async () => {
    // Calico allocates /26 blocks anywhere in its pool, so a pod IP
    // routinely falls outside its own node's spec.podCIDR.
    respond({
      'ippools.crd.projectcalico.org': { items: [{ spec: { cidr: '10.244.0.0/16' } }] },
      nodes: { items: [{ spec: { podCIDR: '10.244.0.0/24' } }] },
    })
    expect(await clusterPodCidrs()).toEqual(['10.244.0.0/16', '10.244.0.0/24'])
  })

  it('unions every node podCIDR when there are no pools', async () => {
    // Multi-node: each node holds a different slice, and missing one
    // means its pods look like world and get redirected.
    respond({ nodes: { items: [
      { spec: { podCIDR: '10.244.1.0/24' } },
      { spec: { podCIDR: '10.244.0.0/24' } },
    ] } })
    expect(await clusterPodCidrs()).toEqual(['10.244.0.0/24', '10.244.1.0/24'])
  })

  it('reads dual-stack podCIDRs but keeps only the v4 ones', async () => {
    respond({ nodes: { items: [
      { spec: { podCIDR: '10.244.0.0/24', podCIDRs: ['10.244.0.0/24', 'fd00::/64'] } },
    ] } })
    expect(await clusterPodCidrs()).toEqual(['10.244.0.0/24'])
  })

  it('skips a disabled IPPool', async () => {
    respond({
      'ippools.crd.projectcalico.org': { items: [
        { spec: { cidr: '10.244.0.0/16' } },
        { spec: { cidr: '192.168.0.0/16', disabled: true } },
      ] },
      nodes: { items: [] },
    })
    expect(await clusterPodCidrs()).toEqual(['10.244.0.0/16'])
  })

  it('treats a cluster without the Calico CRD as a missing source, not an error', async () => {
    getJson.mockImplementation((args: string[]) => {
      if ((args[1] ?? '').startsWith('ippools')) return Promise.reject(new Error('no such resource'))
      return Promise.resolve({ items: [{ spec: { podCIDR: '10.42.0.0/24' } }] }) as never
    })
    expect(await clusterPodCidrs()).toEqual(['10.42.0.0/24'])
  })

  it('never widens a CIDR it was given', async () => {
    // The bug this replaced: a node /24 widened to the containing /16,
    // which is only right for kind's default.
    respond({ nodes: { items: [{ spec: { podCIDR: '172.20.5.0/24' } }] } })
    expect(await clusterPodCidrs()).toEqual(['172.20.5.0/24'])
  })

  it('falls back to the documented default when nothing publishes a CIDR', async () => {
    respond({ nodes: { items: [] } })
    expect(await clusterPodCidrs()).toEqual([FALLBACK_POD_CIDR])
  })

  it('drops malformed values rather than rendering an unparseable rule', async () => {
    respond({ nodes: { items: [{ spec: { podCIDR: 'not-a-cidr' } }] } })
    expect(await clusterPodCidrs()).toEqual([FALLBACK_POD_CIDR])
  })

  it('caches, and the reset clears it with the node cache', async () => {
    respond({ nodes: { items: [{ spec: { podCIDR: '10.244.0.0/24' } }] } })
    await clusterPodCidrs()
    const afterFirst = getJson.mock.calls.length
    await clusterPodCidrs()
    expect(getJson.mock.calls.length).toBe(afterFirst)
    resetClusterCidrCache()
    await clusterPodCidrs()
    expect(getJson.mock.calls.length).toBeGreaterThan(afterFirst)
  })
})
