import { describe, it, expect, vi, beforeEach } from 'vitest'

// Manifests are rendered for a known namespace.
beforeEach(() => { vi.stubEnv('YAAC_K8S_NAMESPACE', 'test-ns') })


import {
  buildEgressWorldDenyNpManifest,
  buildProxyIngressNpManifest,
  buildServerFrontIngressNpManifest,
  buildServerIngressNpManifest,
  buildWorkspaceEgressNpManifest,
  egressAllButServerFront,
} from '#drivers/k8s/cluster'
import {
  EGRESS_WORLD_DENY_NAME,
  LABEL_ROLE,
  PROXY_APP_NAME,
  PROXY_INGRESS_NP_NAME,
  SERVER_APP_NAME,
  SERVER_FRONT_INGRESS_NP_NAME,
  SERVER_FRONT_PORT,
  SERVER_INGRESS_NP_NAME,
  SERVER_MAMA_PORT,
  SERVER_POD_PORT,
  WORKSPACE_EGRESS_NP_NAME,
} from '#drivers/k8s/substrate/proxy-constants'
import { LABEL_WORKSPACE_ID } from '#drivers/k8s/substrate/pods'

interface Spec {
  podSelector: Record<string, unknown>
  policyTypes: string[]
  egress?: unknown[]
}

// The policy builders the cluster folder exports. The other manifests are
// internal and asserted where `ensureProxyResources` applies them.
//
// These cases focus on the ipBlock rules: a policy built from the wrong node
// addresses still applies cleanly and silently denies the traffic it should
// allow.

describe('buildEgressWorldDenyNpManifest', () => {
  const np = buildEgressWorldDenyNpManifest()
  const spec = np.spec as Spec

  it('default-denies egress with an empty rule list', () => {
    // NetworkPolicy has no deny rule; an empty egress list denies all.
    expect(np.metadata).toMatchObject({ name: EGRESS_WORLD_DENY_NAME })
    expect(spec.egress).toEqual([])
    expect(spec.policyTypes).toEqual(['Egress'])
  })

  it('exempts only the proxy, the server, session pods, and builders', () => {
    // NotIn/DoesNotExist also match unlabelled pods, so new pods are denied
    // by default. The server, like the proxy, needs the internet (git
    // clones, fetches).
    expect(spec.podSelector).toEqual({
      matchExpressions: [
        { key: 'app', operator: 'NotIn', values: [PROXY_APP_NAME, SERVER_APP_NAME] },
        { key: LABEL_WORKSPACE_ID, operator: 'DoesNotExist' },
        { key: LABEL_ROLE, operator: 'NotIn', values: ['builder'] },
      ],
    })
  })
})

describe('buildWorkspaceEgressNpManifest', () => {
  it('admits the node CIDRs it is given, and nothing world-ward', () => {
    const np = buildWorkspaceEgressNpManifest(['10.89.0.7/32', '10.244.93.192/32']) as unknown as {
      metadata: { name: string; namespace: string }
      spec: { policyTypes: string[]; egress: Array<{ to?: Array<{ ipBlock?: { cidr: string } }> }> }
    }

    expect(np.metadata.name).toBe(WORKSPACE_EGRESS_NP_NAME)
    expect(np.metadata.namespace).toBe('test-ns')
    expect(np.spec.policyTypes).toEqual(['Egress'])
    // Every destination is a node address: a workspace reaches the
    // internet only through netd's node-local listener, so egress fails
    // closed when netd is missing.
    const cidrs = np.spec.egress.flatMap((r) => (r.to ?? []).map((t) => t.ipBlock?.cidr))
    expect(cidrs).toContain('10.89.0.7/32')
    expect(cidrs).toContain('10.244.93.192/32')
    expect(cidrs.every((c) => c === undefined || c.endsWith('/32'))).toBe(true)
  })

  // npm cache access is per project, granted by the cache's own
  // label-keyed policy (npm-cache.test.ts).
  it('grants no workspace the npm cache', () => {
    expect(JSON.stringify(buildWorkspaceEgressNpManifest(['10.89.0.7/32']))).not.toContain('yaac-npm-cache')
  })
})

describe('buildProxyIngressNpManifest', () => {
  it('locks the proxy to the node CIDRs, so only netd may originate PP2', () => {
    // The transparent ports trust a PROXY-protocol header naming the
    // source pod. A pod that could dial them directly could claim to be any
    // workspace, so only node addresses are allowed.
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
  it('admits the node addresses it is given to the API, and the proxy only to the mama port', () => {
    // No pod may reach the API: the kubelet probe and, on kind, the
    // forwarder's dial come from node addresses. The proxy forwards
    // workspace traffic, so it reaches only the mama listener.
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
    }, {
      from: [{ podSelector: { matchLabels: { app: PROXY_APP_NAME } } }],
      ports: [{ protocol: 'TCP', port: SERVER_MAMA_PORT }],
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

    // No peers admits nothing. It is still applied on kind, so a
    // re-install that turns fronting off replaces the old peer.
    const none = buildServerFrontIngressNpManifest([]) as unknown as { spec: IngressSpec }
    expect(none.spec.ingress).toEqual([])
  })
})

describe('egressAllButServerFront', () => {
  // A builder RUN step or proxy upstream reaching the kind fronting's node
  // port would reach the server as if it were the node. So node addresses
  // are allowed on every port except that one.
  const rules = egressAllButServerFront(['10.89.0.2/32', '192.168.1.1/32']) as Array<{
    to: Array<{ ipBlock: { cidr: string; except?: string[] } }>
    ports?: Array<{ protocol: string; port: number; endPort: number }>
  }>

  it('reaches everything off the nodes, on every port', () => {
    const [world] = rules
    expect(world.ports).toBeUndefined()
    expect(world.to).toContainEqual({ ipBlock: { cidr: '0.0.0.0/0', except: ['10.89.0.2/32', '192.168.1.1/32'] } })
  })

  it('reaches the nodes on every port but the fronting\'s', () => {
    const [, nodes] = rules
    expect(nodes.to.map((p) => p.ipBlock.cidr)).toEqual(['10.89.0.2/32', '192.168.1.1/32'])
    const tcp = (nodes.ports ?? []).filter((p) => p.protocol === 'TCP')
    const covers = (port: number): boolean => tcp.some((p) => p.port <= port && port <= p.endPort)
    expect(covers(SERVER_FRONT_PORT)).toBe(false)
    for (const port of [1, 22, 10250, SERVER_FRONT_PORT - 1, SERVER_FRONT_PORT + 1, 65535]) {
      expect(covers(port), String(port)).toBe(true)
    }
    expect(nodes.ports).toContainEqual({ protocol: 'UDP', port: 1, endPort: 65535 })
  })
})
