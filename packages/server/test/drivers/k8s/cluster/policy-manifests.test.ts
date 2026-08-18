import { describe, it, expect, vi } from 'vitest'

vi.mock('#drivers/k8s/substrate/kubectl', () => ({
  isKubectlAbsentError: vi.fn(() => false),
  kubectlErrorSummary: vi.fn((e: unknown) => String(e)),
  k8sNamespace: vi.fn(() => 'test-ns'),
}))

import {
  buildEgressWorldDenyNpManifest,
  buildProxyIngressNpManifest,
  buildWorktreeEgressNpManifest,
} from '#drivers/k8s/cluster'
import {
  EGRESS_WORLD_DENY_NAME,
  LABEL_ROLE,
  PROXY_APP_NAME,
  PROXY_INGRESS_NP_NAME,
  WORKTREE_EGRESS_NP_NAME,
} from '#drivers/k8s/substrate/proxy-constants'
import { LABEL_WORKTREE_ID } from '#drivers/k8s/substrate/pods'

interface Spec {
  podSelector: Record<string, unknown>
  policyTypes: string[]
  egress?: unknown[]
}

// Three builders leave this folder. The image feature re-applies the
// install-wide world-deny after a builder pod exits; the other two are what
// `cluster check`'s egress gate renders to decide what it should be able to
// prove. Every other manifest here is internal and asserted where it is
// applied — the session/proxy set through `ensureProxyResources`.
//
// What these cases pin is the ipBlock plumbing, because that is the half
// that fails silently: a policy rendered from the wrong node addresses
// still applies cleanly and simply denies the traffic it was meant to
// admit.

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

describe('buildWorktreeEgressNpManifest', () => {
  it('admits the node CIDRs it is given, and nothing world-ward', () => {
    const np = buildWorktreeEgressNpManifest(['10.89.0.7/32', '10.244.93.192/32']) as unknown as {
      metadata: { name: string; namespace: string }
      spec: { policyTypes: string[]; egress: Array<{ to?: Array<{ ipBlock?: { cidr: string } }> }> }
    }

    expect(np.metadata.name).toBe(WORKTREE_EGRESS_NP_NAME)
    expect(np.metadata.namespace).toBe('test-ns')
    expect(np.spec.policyTypes).toEqual(['Egress'])
    // Every destination is one of the node blocks: the worktree's only
    // world-ward path is netd's node-local listener, which is what makes
    // the egress lockdown fail CLOSED when netd is late or absent.
    const cidrs = np.spec.egress.flatMap((r) => (r.to ?? []).map((t) => t.ipBlock?.cidr))
    expect(cidrs).toContain('10.89.0.7/32')
    expect(cidrs).toContain('10.244.93.192/32')
    expect(cidrs.every((c) => c === undefined || c.endsWith('/32'))).toBe(true)
  })
})

describe('buildProxyIngressNpManifest', () => {
  it('locks the proxy to the node CIDRs, so only netd may originate PP2', () => {
    // The transparent ports carry a PROXY-protocol preamble naming the
    // source pod. A pod that could dial them directly could claim to be
    // any worktree, so the ingress is node-only — the forgery guard.
    const np = buildProxyIngressNpManifest(['10.89.0.7/32']) as unknown as {
      metadata: { name: string }
      spec: {
        podSelector: Record<string, unknown>
        policyTypes: string[]
        ingress: Array<{ from?: Array<{ ipBlock?: { cidr: string } }> }>
      }
    }

    expect(np.metadata.name).toBe(PROXY_INGRESS_NP_NAME)
    expect(np.spec.podSelector).toEqual({ matchLabels: { app: PROXY_APP_NAME } })
    expect(np.spec.policyTypes).toEqual(['Ingress'])
    expect(np.spec.ingress.flatMap((r) => (r.from ?? []).map((f) => f.ipBlock?.cidr)))
      .toContain('10.89.0.7/32')
  })
})
