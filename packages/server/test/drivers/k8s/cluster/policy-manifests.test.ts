import { describe, it, expect, vi, beforeEach } from 'vitest'

// Manifests are rendered for a known namespace.
beforeEach(() => { vi.stubEnv('YAAC_K8S_NAMESPACE', 'test-ns') })


import {
  buildEgressWorldDenyNpManifest,
  buildProxyEgressNpManifest,
  buildProxyIngressNpManifest,
  buildServerFrontIngressNpManifest,
  buildServerIngressNpManifest,
  buildWorkspaceEgressNpManifest,
  builderEgress,
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
  SERVER_PROBE_PORT,
  POD_STREAM_PORT,
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
  it('admits node addresses to the probe, to the API only when forwarded, and the proxy only to the mama port', () => {
    // No pod may reach the API. Node addresses reach it only behind the kind
    // forwarder, whose dial comes from the node; elsewhere a host-networked
    // process could claim any identity there. The proxy forwards workspace
    // traffic, so it reaches only the mama listener.
    const nodes = ['10.89.0.2/32', '10.244.93.192/32']
    const render = (forwarded: boolean) => buildServerIngressNpManifest(nodes, forwarded) as unknown as {
      metadata: { name: string }
      spec: IngressSpec
    }
    const np = render(true)
    expect(np.metadata.name).toBe(SERVER_INGRESS_NP_NAME)
    expect(np.spec.podSelector).toEqual({ matchLabels: { app: SERVER_APP_NAME } })
    expect(np.spec.policyTypes).toEqual(['Ingress'])
    const fromNodes = [{ ipBlock: { cidr: '10.89.0.2/32' } }, { ipBlock: { cidr: '10.244.93.192/32' } }]
    const fromProxy = {
      from: [{ podSelector: { matchLabels: { app: PROXY_APP_NAME } } }],
      ports: [{ protocol: 'TCP', port: SERVER_MAMA_PORT }],
    }
    expect(np.spec.ingress).toEqual([{
      from: fromNodes,
      ports: [{ protocol: 'TCP', port: SERVER_PROBE_PORT }, { protocol: 'TCP', port: SERVER_POD_PORT }],
    }, fromProxy])
    expect(render(false).spec.ingress).toEqual([
      { from: fromNodes, ports: [{ protocol: 'TCP', port: SERVER_PROBE_PORT }] },
      fromProxy,
    ])
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

describe('builderEgress', () => {
  // A builder RUN step or proxy upstream reaching the kind fronting's node
  // port would reach the server as if it were the node, and one reaching a
  // node-hosted NFS export, a metadata service or any other internal
  // address could read what only the cluster may. Only public addresses,
  // DNS and the nodes stay open; the operator opens anything else.
  const rules = builderEgress(['10.89.0.2/32', '192.168.1.1/32'], ['10.96.0.10/32']) as Array<{
    to: Array<{ ipBlock?: { cidr: string; except?: string[] } }>
    ports?: Array<{ protocol: string; port: number; endPort: number }>
  }>

  it('reaches public addresses on every port, and no special-purpose range', () => {
    const [world] = rules
    expect(world.ports).toBeUndefined()
    const [v4, v6] = world.to.map((p) => p.ipBlock!)
    expect(v4.cidr).toBe('0.0.0.0/0')
    for (const cidr of [
      '10.89.0.2/32', '192.168.1.1/32', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16',
      '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '168.63.129.16/32', '224.0.0.0/3',
    ]) expect(v4.except).toContain(cidr)
    // ULA (fd00:ec2::254, fd20:ce::254) and link-local lie outside it.
    expect(v6).toEqual({ cidr: '2000::/3', except: ['2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20'] })
  })

  // NodeLocal DNSCache answers on the DNS Service's own ClusterIP (no DNAT
  // to a CoreDNS pod) or on link-local, depending on its mode.
  it('reaches DNS by selector, at the DNS Service, and on link-local', () => {
    expect(rules[1]).toEqual({
      to: [
        {
          namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
          podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
        },
        { ipBlock: { cidr: '10.96.0.10/32' } },
        { ipBlock: { cidr: '169.254.0.0/16' } },
      ],
      ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }],
    })
  })

  it('reaches the nodes on every port but the fronting\'s and NFS', () => {
    const [, , nodes] = rules
    expect(nodes.to.map((p) => p.ipBlock?.cidr)).toEqual(['10.89.0.2/32', '192.168.1.1/32'])
    const covers = (protocol: string, port: number): boolean => (nodes.ports ?? [])
      .some((p) => p.protocol === protocol && p.port <= port && port <= p.endPort)
    for (const [protocol, port] of [['TCP', SERVER_FRONT_PORT], ['TCP', 2049], ['UDP', 2049]] as const) {
      expect(covers(protocol, port), `${protocol} ${port}`).toBe(false)
    }
    for (const port of [1, 22, 2048, 2050, 10250, SERVER_FRONT_PORT - 1, SERVER_FRONT_PORT + 1, 65535]) {
      expect(covers('TCP', port), String(port)).toBe(true)
    }
    for (const port of [1, 53, 2048, 2050, 65535]) expect(covers('UDP', port), String(port)).toBe(true)
  })

  it('reaches the main registry by selector, in its own namespace', () => {
    expect(rules[3]).toEqual({
      to: [{
        namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'yaac' } },
        podSelector: { matchLabels: { app: 'yaac-main-registry' } },
      }],
      ports: [{ protocol: 'TCP', port: 5000 }],
    })
  })
})

describe('buildProxyEgressNpManifest', () => {
  const egressOf = (apiserver: { cidrs: string[]; ports: number[] }) =>
    (buildProxyEgressNpManifest(['10.89.0.2/32'], [], apiserver) as unknown as { spec: Spec }).spec.egress!

  it('adds the proxy\'s in-cluster peers to the builders\' floor, by selector', () => {
    const egress = egressOf({ cidrs: [], ports: [] })
    // The same floor, less the builders' registry rule.
    expect(egress.slice(0, 3)).toEqual(builderEgress(['10.89.0.2/32'], []).slice(0, 3))
    expect(egress.slice(3)).toEqual([
      { to: [{ podSelector: { matchLabels: { app: SERVER_APP_NAME } } }], ports: [{ protocol: 'TCP', port: SERVER_MAMA_PORT }] },
      {
        to: [{ podSelector: { matchExpressions: [{ key: LABEL_WORKSPACE_ID, operator: 'Exists' }] } }],
        ports: [{ protocol: 'TCP', port: POD_STREAM_PORT }],
      },
    ])
  })

  it('reaches the apiserver at its real endpoints when they are published', () => {
    expect(egressOf({ cidrs: ['172.20.0.10/32', '172.20.0.11/32'], ports: [443] }).at(-1)).toEqual({
      to: [{ ipBlock: { cidr: '172.20.0.10/32' } }, { ipBlock: { cidr: '172.20.0.11/32' } }],
      ports: [{ protocol: 'TCP', port: 443 }],
    })
  })
})
