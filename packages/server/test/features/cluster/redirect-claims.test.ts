import { describe, expect, it, vi } from 'vitest'

vi.mock('#platform/k8s/kubectl', () => ({
  isKubectlAbsentError: vi.fn(() => false),
  kubectlErrorSummary: vi.fn((e: unknown) => String(e)),
  k8sNamespace: () => 'test-ns',
}))

import {
  buildRedirectClaimsConfigMapManifest,
  isClaimConfigMapName,
  renderNamespaceClaims,
  validateVclusterClaims,
} from '#features/cluster'
import type { VclusterPod } from '#platform/k8s/vcluster-objects'
// Bounds and object names the claim bridge enforces — setup values for the
// assertions below, not units under test.
import {
  MAX_CLAIMS_PER_NAMESPACE,
  MAX_SOURCES_PER_CLAIM,
  REDIRECT_CLAIMS_CM_NAME,
} from '#features/cluster/redirect-claims'

const VC = 'yvc1'
const PROXY_IP = '10.244.0.31'
const SESSION_IP = '10.244.0.44'

function synced(name: string, podIP: string, labels: Record<string, string> = {}): VclusterPod {
  return { name, podIP, labels: { 'vcluster.loft.sh/managed-by': VC, ...labels } }
}

const PODS = [synced('inner-proxy', PROXY_IP), synced('inner-sess', SESSION_IP)]

function doc(claim: Record<string, unknown>): string {
  return JSON.stringify(claim)
}

const CLAIM = { install: 'hash1', proxyPodIp: PROXY_IP, sources: [SESSION_IP] }

function validate(documents: string[], pods: VclusterPod[] = PODS) {
  return validateVclusterClaims({ vclusterName: VC, documents, pods })
}

describe('isClaimConfigMapName', () => {
  it('matches the syncer-translated name, which keeps the original as a prefix', () => {
    expect(isClaimConfigMapName('yaac-redirect-claim')).toBe(true)
    expect(isClaimConfigMapName('yaac-redirect-claim-x-yaac-x-yvc-abc')).toBe(true)
  })

  it('ignores every other ConfigMap in a vcluster namespace', () => {
    for (const name of ['kube-root-ca.crt', 'coredns', 'yaac-outer-proxy-ca',
      'yaac-redirect-claims', 'redirect-claim']) {
      expect(isClaimConfigMapName(name)).toBe(false)
    }
  })
})

describe('validateVclusterClaims', () => {
  it('keeps a claim whose target and sources are live synced pods', () => {
    expect(validate([doc(CLAIM)])).toEqual([CLAIM])
  })

  it('rejects a target that is not a synced pod IP — the bypass this closes', () => {
    // A tenant can create a Service (or hand-written Endpoints) naming any
    // address; kube-proxy would dereference it from the node netns, where no
    // NetworkPolicy applies. Only addresses the host reports as pod IPs of
    // this vcluster's pods are honoured.
    for (const target of ['203.0.113.7', '10.96.0.77', '10.244.0.99']) {
      expect(validate([doc({ ...CLAIM, proxyPodIp: target })])).toEqual([])
    }
  })

  it('rejects a target pod without the syncer\'s managed-by stamp', () => {
    const unstamped: VclusterPod = { name: 'bare', podIP: PROXY_IP, labels: {} }
    expect(validate([doc(CLAIM)], [unstamped, PODS[1]])).toEqual([])
  })

  it('rejects a target claimed for a different vcluster', () => {
    const other = { name: 'p', podIP: PROXY_IP, labels: { 'vcluster.loft.sh/managed-by': 'yvc2' } }
    expect(validate([doc(CLAIM)], [other, PODS[1]])).toEqual([])
  })

  it('drops unknown sources but keeps the claim', () => {
    const withGhosts = { ...CLAIM, sources: [SESSION_IP, '10.244.9.9', '203.0.113.7'] }
    expect(validate([doc(withGhosts)])[0].sources).toEqual([SESSION_IP])
  })

  it('drops a claim whose every source is unknown', () => {
    expect(validate([doc({ ...CLAIM, sources: ['10.244.9.9'] })])).toEqual([])
  })

  it('never lets a claim redirect its own proxy', () => {
    const selfClaim = { ...CLAIM, sources: [SESSION_IP, PROXY_IP] }
    expect(validate([doc(selfClaim)])[0].sources).toEqual([SESSION_IP])
  })

  it('is total against tenant-authored garbage', () => {
    expect(validate(['', '   ', '{ not json', 'null', '[]', '"str"',
      doc({ install: 'h' }), doc({ proxyPodIp: PROXY_IP }),
      doc({ install: 'h'.repeat(200), proxyPodIp: PROXY_IP, sources: [SESSION_IP] }),
      doc({ install: 'h', proxyPodIp: PROXY_IP, sources: 'nope' }),
      doc({ install: 'h', proxyPodIp: PROXY_IP, sources: [42, null] }),
    ])).toEqual([])
  })

  it('sorts by install hash so a contested source resolves stably', () => {
    const second = synced('proxy-b', '10.244.0.32')
    const claims = validate([
      doc({ install: 'zzz', proxyPodIp: second.podIP, sources: [SESSION_IP] }),
      doc({ install: 'aaa', proxyPodIp: PROXY_IP, sources: [SESSION_IP] }),
    ], [...PODS, second])
    expect(claims.map((c) => c.install)).toEqual(['aaa', 'zzz'])
  })

  it('sorts and dedupes sources so the rendering is byte-stable', () => {
    const extra = synced('inner-sess-2', '10.244.0.45')
    const claim = { ...CLAIM, sources: ['10.244.0.45', SESSION_IP, '10.244.0.45'] }
    expect(validate([doc(claim)], [...PODS, extra])[0].sources)
      .toEqual([SESSION_IP, '10.244.0.45'])
  })

  it('bounds sources per claim and claims per namespace', () => {
    const many = Array.from({ length: MAX_SOURCES_PER_CLAIM + 100 }, (_, i) =>
      `10.244.${Math.floor(i / 256) + 1}.${i % 256}`)
    const pods = [PODS[0], ...many.map((ip, i) => synced(`s${i}`, ip))]
    expect(validate([doc({ ...CLAIM, sources: many })], pods)[0].sources.length)
      .toBe(MAX_SOURCES_PER_CLAIM)

    const documents = Array.from({ length: MAX_CLAIMS_PER_NAMESPACE + 10 }, (_, i) =>
      doc({ ...CLAIM, install: `h${String(i).padStart(3, '0')}` }))
    expect(validate(documents).length).toBe(MAX_CLAIMS_PER_NAMESPACE)
  })

  it('is empty with no documents at all', () => {
    expect(validate([])).toEqual([])
  })
})

describe('renderNamespaceClaims', () => {
  it('names the vcluster alongside its claims', () => {
    expect(JSON.parse(renderNamespaceClaims(VC, [CLAIM])) as unknown)
      .toEqual({ vcluster: VC, claims: [CLAIM] })
  })

  it('bounds the claim list', () => {
    const claims = Array.from({ length: MAX_CLAIMS_PER_NAMESPACE + 5 }, (_, i) => ({
      ...CLAIM, install: `h${i}`,
    }))
    const rendered = JSON.parse(renderNamespaceClaims(VC, claims)) as { claims: unknown[] }
    expect(rendered.claims.length).toBe(MAX_CLAIMS_PER_NAMESPACE)
  })
})

describe('buildRedirectClaimsConfigMapManifest', () => {
  it('lands in the install namespace, keyed by vcluster namespace', () => {
    const data = { 'test-ns-vc-abc': renderNamespaceClaims(VC, [CLAIM]) }
    expect(buildRedirectClaimsConfigMapManifest(data)).toEqual({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: REDIRECT_CLAIMS_CM_NAME,
        namespace: 'test-ns',
        labels: { app: 'yaac-netd' },
      },
      data,
    })
  })

  it('renders an empty document when nothing is claimed', () => {
    expect(buildRedirectClaimsConfigMapManifest({}).data).toEqual({})
  })
})
