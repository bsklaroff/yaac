import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/k8s/kubectl', () => ({
  k8sNamespace: vi.fn(() => 'yaac'),
  kubectlGetJson: vi.fn(),
  kubectlApply: vi.fn().mockResolvedValue(undefined),
  kubectlWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))
// bootstrap.ts (imported for the real builders) only uses isTorEnabled from git.
vi.mock('@/lib/git', () => ({ isTorEnabled: vi.fn(() => false) }))
vi.mock('@/lib/k8s/vcluster', () => ({
  LABEL_VCLUSTER_MANAGED_BY: 'vcluster.loft.sh/managed-by',
  listVclusterNamespaces: vi.fn().mockResolvedValue([]),
}))

import { reconcileInnerRedirects } from '@/lib/session/inner-redirect-reconcile'
import { kubectlApply, kubectlGetJson, kubectlWithRetry } from '@/lib/k8s/kubectl'
import { listVclusterNamespaces } from '@/lib/k8s/vcluster'
import {
  INNER_EGRESS_REDIRECT_CEC_NAME,
  INNER_PROXY_INGRESS_CNP_NAME,
  INNER_SESSION_EGRESS_REDIRECT_CNP_NAME,
} from '@/lib/k8s/bootstrap'

const mockGetJson = vi.mocked(kubectlGetJson)
const mockApply = vi.mocked(kubectlApply)
const mockRetry = vi.mocked(kubectlWithRetry)
const mockList = vi.mocked(listVclusterNamespaces)

const VC = { name: 'yvc-1', sessionId: 's1', namespace: 'yaac-vc-1', creationTimestamp: '' }
const SYNCED_SVC = 'yaac-proxy-x-yaac-x-yvc-1' // vcluster-translated inner proxy Service

function appliedNames(): Array<{ kind: string; name: string; namespace: string }> {
  return mockApply.mock.calls.map(([m]) => {
    const o = m as { kind: string; metadata: { name: string; namespace: string } }
    return { kind: o.kind, name: o.metadata.name, namespace: o.metadata.namespace }
  })
}

describe('reconcileInnerRedirects', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockList.mockResolvedValue([])
    mockGetJson.mockResolvedValue({ items: [] })
  })

  it('no-ops when there are no managed vclusters', async () => {
    await reconcileInnerRedirects()
    expect(mockApply).not.toHaveBeenCalled()
    expect(mockRetry).not.toHaveBeenCalled()
  })

  it('projects the inner override when the inner proxy is up (no fallback — that is creation-time)', async () => {
    mockList.mockResolvedValue([VC])
    mockGetJson.mockResolvedValue({ items: [{ metadata: { name: SYNCED_SVC } }] })

    await reconcileInnerRedirects()

    // Only the three inner objects — the fallback is seeded at creation, not here.
    expect(appliedNames()).toEqual([
      { kind: 'CiliumEnvoyConfig', name: INNER_EGRESS_REDIRECT_CEC_NAME, namespace: 'yaac-vc-1' },
      { kind: 'CiliumNetworkPolicy', name: INNER_SESSION_EGRESS_REDIRECT_CNP_NAME, namespace: 'yaac-vc-1' },
      { kind: 'CiliumNetworkPolicy', name: INNER_PROXY_INGRESS_CNP_NAME, namespace: 'yaac-vc-1' },
    ])
    expect(mockRetry).not.toHaveBeenCalled()

    // The inner CEC is EDS-backed by the discovered (translated) Service name.
    const innerCec = mockApply.mock.calls[0][0] as { spec: { backendServices: Array<{ name: string }> } }
    expect(innerCec.spec.backendServices[0].name).toBe(SYNCED_SVC)
  })

  it('prunes the inner override when the inner proxy is gone (fallback untouched)', async () => {
    mockList.mockResolvedValue([VC])
    mockGetJson.mockResolvedValue({ items: [] }) // no inner proxy Service

    await reconcileInnerRedirects()

    // Nothing applied; inner override deleted (ignore-not-found).
    expect(appliedNames()).toEqual([])
    const deletes = mockRetry.mock.calls.map(([args]) => args.join(' '))
    expect(deletes).toEqual([
      `delete ciliumenvoyconfig ${INNER_EGRESS_REDIRECT_CEC_NAME} -n yaac-vc-1 --ignore-not-found`,
      `delete ciliumnetworkpolicy ${INNER_SESSION_EGRESS_REDIRECT_CNP_NAME} -n yaac-vc-1 --ignore-not-found`,
      `delete ciliumnetworkpolicy ${INNER_PROXY_INGRESS_CNP_NAME} -n yaac-vc-1 --ignore-not-found`,
    ])
  })
})
