/**
 * The cluster's own addresses, as the policies name them: which `/32`s are
 * "the host network namespace", and which CIDRs are "a pod rather than the
 * world".
 *
 * Both answers fail in the same silent direction — an empty or narrow set
 * renders a policy that denies the redirect delivery path or sends
 * pod-to-pod traffic into the proxy — so what these cases pin is the
 * refusal and the reporting, not just the happy read.
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
    // Calico sources host-originated traffic to a pod on ANOTHER node from
    // the sending node's tunnel address, not its InternalIP. A policy
    // naming only InternalIPs therefore drops netd's Envoy on every
    // cross-node hop — and never reproduces on one node, where Calico
    // exempts local host-to-pod traffic from workload policy.
    mockKubectlGetJson.mockResolvedValue({
      items: [
        node('10.89.0.21', { 'projectcalico.org/IPv4IPIPTunnelAddr': '10.244.93.192' }),
        node('10.89.0.20', { 'projectcalico.org/IPv4VXLANTunnelAddr': '10.244.86.128' }),
        // A node the overlay has not annotated yet still contributes its
        // InternalIP rather than dropping out of the policy entirely.
        node('10.89.0.19'),
      ],
    })

    await expect(nodeIpBlocks()).resolves.toEqual([
      '10.244.86.128/32', '10.244.93.192/32',
      '10.89.0.19/32', '10.89.0.20/32', '10.89.0.21/32',
    ])
  })

  it('throws rather than answering empty when no address resolves', async () => {
    // An empty ipBlock set renders a policy that silently denies the
    // redirect delivery path — "all worktrees lost egress", no cause.
    mockKubectlGetJson.mockResolvedValue({ items: [] })
    await expect(nodeIpBlocks()).rejects.toThrow(/could not resolve any node InternalIP/)
  })

  it('caches the answer, and the reset hook is what lets a rebuild change it', async () => {
    mockKubectlGetJson.mockResolvedValue({ items: [node('10.89.0.7')] })
    await expect(nodeIpBlocks()).resolves.toEqual(['10.89.0.7/32'])
    await nodeIpBlocks()
    expect(mockKubectlGetJson).toHaveBeenCalledOnce()

    // Node addresses change only when the cluster is rebuilt — and a
    // process that outlives one would otherwise render every policy for
    // the dead cluster's addresses, which fail closed.
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
    // A typo'd entry that vanishes leaves the exclusion set NARROWER than
    // the operator believes — and the pods in that range get redirected
    // into the proxy. Reported, never silently discarded.
    staged({ pools: { items: [] } })
    vi.stubEnv('YAAC_POD_CIDRS', '172.31.0.0/16, 172.31/16, 10.0.0.0/33')

    const { configured, droppedConfigured } = await podCidrSources()

    expect(configured).toEqual(['172.31.0.0/16'])
    expect([...droppedConfigured].sort()).toEqual(['10.0.0.0/33', '172.31/16'])
  })

  it('separates a source that is absent from one it could not read', async () => {
    // A cluster without Calico serves no IPPool CRD — that source does not
    // exist. An RBAC denial scoped to ippools looks identical from the
    // outside and would silently narrow the set, so it is reported.
    staged({ pools: { items: [] } })
    expect((await podCidrSources()).unreadable).toEqual([])

    staged({ fail: 'ippools' })
    const { unreadable } = await podCidrSources()
    expect(unreadable).toHaveLength(1)
    expect(unreadable[0].source).toMatch(/ippool/i)
  })
})
