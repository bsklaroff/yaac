import { describe, it, expect, vi } from 'vitest'

vi.mock('#drivers/k8s/substrate/kubectl', () => ({
  isKubectlAbsentError: vi.fn(() => false),
  kubectlErrorSummary: vi.fn((e: unknown) => String(e)),
  k8sNamespace: vi.fn(() => 'test-ns'),
}))

import {
  buildEgressWorldDenyNpManifest,
  buildProxyIngressNpManifest,
  buildServerFrontIngressNpManifest,
  buildServerIngressNpManifest,
  buildWorktreeEgressNpManifest,
} from '#drivers/k8s/cluster'
import {
  EGRESS_WORLD_DENY_NAME,
  LABEL_ROLE,
  PROXY_APP_NAME,
  PROXY_INGRESS_NP_NAME,
  SERVER_APP_NAME,
  SERVER_FRONT_INGRESS_NP_NAME,
  SERVER_INGRESS_NP_NAME,
  SERVER_POD_PORT,
  WORKTREE_EGRESS_NP_NAME,
} from '#drivers/k8s/substrate/proxy-constants'
import { LABEL_WORKTREE_ID } from '#drivers/k8s/substrate/pods'

interface Spec {
  podSelector: Record<string, unknown>
  policyTypes: string[]
  egress?: unknown[]
}

// Five builders leave this folder. The image feature re-applies the
// install-wide world-deny after a builder pod exits; two more are what
// `cluster check`'s egress gate renders to decide what it should be able to
// prove; and the server's ingress wall is two objects — a node half the
// server itself re-renders at attach, and a fronting half only install
// applies. Every other manifest here is internal and asserted where it is
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

  it('exempts only the proxy, the server, session pods, and builders', () => {
    // NotIn/DoesNotExist also match pods carrying no such label, so
    // anything added later stays covered by default. The server is exempt
    // for the same reason the proxy is — it reaches the world on purpose
    // (git clones, fetches), and it is the thing doing the mediating
    // rather than a thing to be mediated.
    expect(spec.podSelector).toEqual({
      matchExpressions: [
        { key: 'app', operator: 'NotIn', values: [PROXY_APP_NAME, SERVER_APP_NAME] },
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

interface IngressSpec {
  podSelector: Record<string, unknown>
  policyTypes: string[]
  ingress: Array<{ from?: Array<Record<string, unknown>>; ports?: unknown[] }>
}

describe('buildServerIngressNpManifest', () => {
  it('admits exactly the node addresses it is given, and nothing pod-shaped', () => {
    // An explicit allow: what must never reach the server is a pod, so the
    // rule names no podSelector in the install namespace and no pod CIDR.
    // What it does name is every node address — the kubelet probe and, on
    // kind, the forwarder's dial arrive sourced from one of them.
    const np = buildServerIngressNpManifest(['10.89.0.2/32', '10.244.93.192/32']) as unknown as {
      metadata: { name: string }
      spec: IngressSpec
    }
    expect(np.metadata.name).toBe(SERVER_INGRESS_NP_NAME)
    expect(np.spec.podSelector).toEqual({ matchLabels: { app: SERVER_APP_NAME } })
    expect(np.spec.policyTypes).toEqual(['Ingress'])
    expect(np.spec.ingress).toEqual([{
      from: [{ ipBlock: { cidr: '10.89.0.2/32' } }, { ipBlock: { cidr: '10.244.93.192/32' } }],
      ports: [{ protocol: 'TCP', port: SERVER_POD_PORT }],
    }])
  })
})

describe('buildServerFrontIngressNpManifest', () => {
  it('renders the fronting peers, and an empty ingress for none', () => {
    const peer = {
      namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'tailscale' } },
      podSelector: { matchLabels: { 'tailscale.com/parent-resource': SERVER_APP_NAME } },
    }
    const np = buildServerFrontIngressNpManifest([peer]) as unknown as {
      metadata: { name: string }
      spec: IngressSpec
    }
    expect(np.metadata.name).toBe(SERVER_FRONT_INGRESS_NP_NAME)
    expect(np.spec.podSelector).toEqual({ matchLabels: { app: SERVER_APP_NAME } })
    expect(np.spec.ingress).toEqual([{ from: [peer], ports: [{ protocol: 'TCP', port: SERVER_POD_PORT }] }])

    // No peers is a policy that admits nothing — applied anyway on kind so
    // a fronting switched on re-install overwrites the old peer.
    const none = buildServerFrontIngressNpManifest([]) as unknown as { spec: IngressSpec }
    expect(none.spec.ingress).toEqual([])
  })
})
