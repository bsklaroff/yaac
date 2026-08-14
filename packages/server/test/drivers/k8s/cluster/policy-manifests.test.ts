import { describe, it, expect, vi } from 'vitest'

vi.mock('#drivers/k8s/substrate/kubectl', () => ({
  isKubectlAbsentError: vi.fn(() => false),
  kubectlErrorSummary: vi.fn((e: unknown) => String(e)),
  k8sNamespace: vi.fn(() => 'test-ns'),
}))

import { buildEgressWorldDenyNpManifest } from '#drivers/k8s/cluster'
import { EGRESS_WORLD_DENY_NAME, LABEL_ROLE, PROXY_APP_NAME } from '#drivers/k8s/substrate/proxy-constants'
import { LABEL_WORKTREE_ID } from '#drivers/k8s/substrate/pods'

interface Spec {
  podSelector: Record<string, unknown>
  policyTypes: string[]
  egress?: unknown[]
}

// The only policy builder outside the folder needs: the image feature
// re-applies the install-wide world-deny after a builder pod exits. Every
// other manifest in policy-manifests.ts is internal and asserted where it is
// applied — the session/proxy set through `ensureProxyResources`.

describe('buildEgressWorldDenyNpManifest', () => {
  const np = buildEgressWorldDenyNpManifest()
  const spec = np.spec as Spec

  it('default-denies egress with an empty rule list', () => {
    // Plain NP has no deny verb; an empty egress over a selector is how
    // NP expresses one.
    expect(np.metadata).toMatchObject({ name: EGRESS_WORLD_DENY_NAME })
    expect(spec.egress).toEqual([])
    expect(spec.policyTypes).toEqual(['Egress'])
  })

  it('exempts only the proxy, session pods, and builders', () => {
    // NotIn/DoesNotExist also match pods carrying no such label, so
    // anything added later stays covered by default.
    expect(spec.podSelector).toEqual({
      matchExpressions: [
        { key: 'app', operator: 'NotIn', values: [PROXY_APP_NAME] },
        { key: LABEL_WORKTREE_ID, operator: 'DoesNotExist' },
        { key: LABEL_ROLE, operator: 'NotIn', values: ['builder'] },
      ],
    })
  })
})
