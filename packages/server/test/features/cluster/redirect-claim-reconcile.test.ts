import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockApply = vi.hoisted(() => vi.fn())
vi.mock('#platform/k8s/kubectl', () => ({
  isKubectlAbsentError: vi.fn(() => false),
  kubectlErrorSummary: vi.fn((e: unknown) => String(e)),
  kubectlApply: mockApply,
  k8sNamespace: () => 'test-ns',
}))
vi.mock('#platform/k8s/tick-snapshot', () => ({ createTickSnapshot: vi.fn() }))
vi.mock('#log', () => ({ serverLog: vi.fn() }))

import {
  buildValidatedClaimData,
  reconcileRedirectClaims,
  _resetRedirectClaimsForTests,
} from '#features/cluster/redirect-claim-reconcile'
import { CLAIM_KEY } from '#features/cluster/redirect-claims'
import type { TickSnapshot } from '#platform/k8s/tick-snapshot'
import type {
  VclusterConfigMap,
  VclusterNamespaceInfo,
  VclusterPod,
} from '#platform/k8s/vcluster-objects'

const VC_NS = 'test-ns-vc-1'
const VC_NAME = 'yvc-s1'
const PROXY_IP = '10.244.0.31'
const SESSION_IP = '10.244.0.44'

const vc = (ns = VC_NS, name = VC_NAME): VclusterNamespaceInfo =>
  ({ name, worktreeId: 's1', namespace: ns, creationTimestamp: '' })

const synced = (name: string, podIP: string, vcName = VC_NAME): VclusterPod =>
  ({ name, podIP, labels: { 'vcluster.loft.sh/managed-by': vcName } })

const claimCm = (claim: unknown, name = 'yaac-redirect-claim-x-yaac-x-yvc'): VclusterConfigMap =>
  ({ name, data: { [CLAIM_KEY]: typeof claim === 'string' ? claim : JSON.stringify(claim) } })

const CLAIM = { install: 'hash1', proxyPodIp: PROXY_IP, sources: [SESSION_IP] }
const PODS = [synced('inner-proxy', PROXY_IP), synced('inner-sess', SESSION_IP)]

function snap(opts: {
  vclusters?: VclusterNamespaceInfo[]
  podsByNs?: Record<string, VclusterPod[]>
  cmsByNs?: Record<string, VclusterConfigMap[]>
} = {}): TickSnapshot {
  return {
    resync: true,
    pods: () => Promise.resolve([]),
    jobs: () => Promise.resolve([]),
    vclusters: () => Promise.resolve(opts.vclusters ?? []),
    vclusterPods: (ns: string) => Promise.resolve(opts.podsByNs?.[ns] ?? []),
    vclusterServices: () => Promise.resolve([]),
    vclusterConfigMaps: (ns: string) => Promise.resolve(opts.cmsByNs?.[ns] ?? []),
  }
}

const ONE_CLAIM = {
  vclusters: [vc()],
  podsByNs: { [VC_NS]: PODS },
  cmsByNs: { [VC_NS]: [claimCm(CLAIM)] },
}

beforeEach(() => {
  vi.clearAllMocks()
  _resetRedirectClaimsForTests()
  mockApply.mockResolvedValue(undefined)
})

describe('buildValidatedClaimData', () => {
  it('keys a validated claim by its vcluster host namespace', async () => {
    const data = await buildValidatedClaimData(snap(ONE_CLAIM))
    expect(JSON.parse(data[VC_NS])).toEqual({ vcluster: VC_NAME, claims: [CLAIM] })
  })

  it('collects every inner install\'s claim in one vcluster', async () => {
    // The ambient nested server plus a per-run e2e server, each with its own
    // proxy and its own claim-mode netd inside the same vcluster.
    const second = synced('proxy-b', '10.244.0.32')
    const secondSess = synced('sess-b', '10.244.0.45')
    const data = await buildValidatedClaimData(snap({
      vclusters: [vc()],
      podsByNs: { [VC_NS]: [...PODS, second, secondSess] },
      cmsByNs: {
        [VC_NS]: [
          claimCm(CLAIM, 'yaac-redirect-claim-x-yaac-x-yvc'),
          claimCm(
            { install: 'hash2', proxyPodIp: '10.244.0.32', sources: ['10.244.0.45'] },
            'yaac-redirect-claim-x-yaac-test-r1-x-yvc',
          ),
        ],
      },
    }))
    const parsed = JSON.parse(data[VC_NS]) as { claims: Array<{ install: string }> }
    expect(parsed.claims.map((c) => c.install)).toEqual(['hash1', 'hash2'])
  })

  it('omits a namespace whose claims all fail validation', async () => {
    const data = await buildValidatedClaimData(snap({
      vclusters: [vc()],
      podsByNs: { [VC_NS]: PODS },
      cmsByNs: { [VC_NS]: [claimCm({ ...CLAIM, proxyPodIp: '203.0.113.7' })] },
    }))
    expect(data).toEqual({})
  })

  it('ignores ConfigMaps that are not claims', async () => {
    // A vcluster namespace holds the syncer's own configmaps too; only the
    // claim ones (by name) are read.
    const data = await buildValidatedClaimData(snap({
      vclusters: [vc()],
      podsByNs: { [VC_NS]: PODS },
      cmsByNs: { [VC_NS]: [{ name: 'kube-root-ca.crt', data: { claim: JSON.stringify(CLAIM) } }] },
    }))
    expect(data).toEqual({})
  })

  it('omits a namespace with no claim ConfigMap and one with an empty claim', async () => {
    expect(await buildValidatedClaimData(snap({
      vclusters: [vc()], podsByNs: { [VC_NS]: PODS },
    }))).toEqual({})
    expect(await buildValidatedClaimData(snap({
      vclusters: [vc()],
      podsByNs: { [VC_NS]: PODS },
      cmsByNs: { [VC_NS]: [claimCm('')] },
    }))).toEqual({})
  })

  it('validates each vcluster against its own pods only', async () => {
    const otherNs = 'test-ns-vc-2'
    const data = await buildValidatedClaimData(snap({
      vclusters: [vc(), vc(otherNs, 'yvc-s2')],
      podsByNs: { [VC_NS]: PODS, [otherNs]: [] },
      // The second vcluster claims the FIRST vcluster's proxy pod IP: no pod
      // of its own has that IP, so nothing survives.
      cmsByNs: { [otherNs]: [claimCm(CLAIM)] },
    }))
    expect(data).toEqual({})
  })

  it('is empty with no vclusters at all', async () => {
    expect(await buildValidatedClaimData(snap())).toEqual({})
  })
})

describe('reconcileRedirectClaims', () => {
  it('applies the claims ConfigMap', async () => {
    await reconcileRedirectClaims(snap(ONE_CLAIM))
    expect(mockApply).toHaveBeenCalledTimes(1)
    const manifest = mockApply.mock.calls[0][0] as { metadata: { name: string }, data: Record<string, string> }
    expect(manifest.metadata.name).toBe('yaac-redirect-claims')
    expect(Object.keys(manifest.data)).toEqual([VC_NS])
  })

  it('writes once for an unchanged claim set', async () => {
    await reconcileRedirectClaims(snap(ONE_CLAIM))
    await reconcileRedirectClaims(snap(ONE_CLAIM))
    expect(mockApply).toHaveBeenCalledTimes(1)
  })

  it('evicts a withdrawn claim by rewriting the whole document', async () => {
    await reconcileRedirectClaims(snap(ONE_CLAIM))
    await reconcileRedirectClaims(snap({
      vclusters: [vc()],
      podsByNs: { [VC_NS]: PODS },
      cmsByNs: { [VC_NS]: [claimCm('')] },
    }))
    expect(mockApply).toHaveBeenCalledTimes(2)
    expect((mockApply.mock.calls[1][0] as { data: Record<string, string> }).data).toEqual({})
  })

  it('drops a claim whose proxy pod went away', async () => {
    await reconcileRedirectClaims(snap(ONE_CLAIM))
    await reconcileRedirectClaims(snap({
      ...ONE_CLAIM,
      podsByNs: { [VC_NS]: [synced('inner-sess', SESSION_IP)] },
    }))
    expect((mockApply.mock.calls[1][0] as { data: Record<string, string> }).data).toEqual({})
  })

  it('writes the empty document on the first pass, so the object always exists', async () => {
    await reconcileRedirectClaims(snap())
    expect(mockApply).toHaveBeenCalledTimes(1)
    expect((mockApply.mock.calls[0][0] as { data: Record<string, string> }).data).toEqual({})
  })

  it('does not remember a failed apply', async () => {
    mockApply.mockRejectedValueOnce(new Error('apiserver down'))
    await reconcileRedirectClaims(snap(ONE_CLAIM))
    await reconcileRedirectClaims(snap(ONE_CLAIM))
    expect(mockApply).toHaveBeenCalledTimes(2)
  })
})
