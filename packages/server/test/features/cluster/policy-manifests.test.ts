import { describe, it, expect, vi } from 'vitest'

vi.mock('#platform/k8s/kubectl', () => ({
  k8sNamespace: vi.fn(() => 'test-ns'),
}))

import {
  buildEgressWorldDenyNpManifest,
  buildInnerProxyIngressNpManifest,
  buildInnerSessionIngressLockNpManifest,
  buildProxyIngressNpManifest,
  buildSessionEgressNpManifest,
  buildSessionIngressLockNpManifest,
  buildVclusterControlPlaneNpManifest,
  buildVclusterEgressFloorNpManifest,
  innerProjectionLabels,
} from '#features/cluster/policy-manifests'
import {
  DNS_STUB_PORT,
  EGRESS_WORLD_DENY_NAME,
  LABEL_ROLE,
  NETD_LISTENER_PORT_BASE,
  NETD_LISTENER_PORT_END,
  POD_STREAM_PORT,
  PROXY_APP_NAME,
  PROXY_PORT,
  RELAY_PORT,
  ROLE_INNER_PROXY,
  SESSION_EGRESS_NP_NAME,
  TRANSPARENT_HTTPS_PORT,
  TRANSPARENT_HTTP_PORT,
  TRANSPARENT_TUNNEL_PORT,
} from '#features/cluster/proxy-constants'
import { LABEL_DATA_DIR_HASH, LABEL_SESSION_ID, LABEL_VCLUSTER_MANAGED_BY } from '#platform/k8s/pods'

const NODES = ['10.89.0.7/32']
const APISERVERS = ['10.89.0.7/32']

interface Rule {
  to?: Array<Record<string, unknown>>
  from?: Array<Record<string, unknown>>
  ports?: Array<{ protocol: string; port: number; endPort?: number }>
}
interface Spec {
  podSelector: Record<string, unknown>
  policyTypes: string[]
  egress?: Rule[]
  ingress?: Rule[]
}
const spec = (manifest: Record<string, unknown>): Spec => manifest.spec as Spec
const ports = (rule: Rule): number[] => (rule.ports ?? []).map((p) => p.port)

/** Every port a rule set admits, ranges expanded to their endpoints. */
function allPorts(rules: Rule[]): number[] {
  return rules.flatMap((r) => (r.ports ?? []).flatMap((p) => [p.port, ...(p.endPort ? [p.endPort] : [])]))
}

describe('buildSessionEgressNpManifest', () => {
  const np = buildSessionEgressNpManifest(NODES)

  it('is a plain networking.k8s.io/v1 NetworkPolicy in the install namespace', () => {
    // Plain NP only: the managed Calicos this keeps cheap treat Calico
    // CRDs as unsupported.
    expect(np.apiVersion).toBe('networking.k8s.io/v1')
    expect(np.kind).toBe('NetworkPolicy')
    expect(np.metadata).toMatchObject({ name: SESSION_EGRESS_NP_NAME, namespace: 'test-ns' })
  })

  it('selects every session pod by the label the session builder stamps', () => {
    expect(spec(np).podSelector).toEqual({
      matchExpressions: [{ key: LABEL_SESSION_ID, operator: 'Exists' }],
    })
  })

  it('grants exactly ONE world-ward rule: the node, on the listener range', () => {
    // The whole fail-closed story. 443/80-to-world must be absent, so a
    // pod whose redirect netd has not programmed reaches nothing.
    const worldward = spec(np).egress!.filter((r) => r.to?.some((peer) => 'ipBlock' in peer))
    expect(worldward).toHaveLength(1)
    expect(worldward[0].to).toEqual([{ ipBlock: { cidr: '10.89.0.7/32' } }])
    expect(worldward[0].ports).toEqual([{
      protocol: 'TCP', port: NETD_LISTENER_PORT_BASE, endPort: NETD_LISTENER_PORT_END,
    }])
    expect(allPorts(spec(np).egress!)).not.toContain(443)
    expect(allPorts(spec(np).egress!)).not.toContain(80)
  })

  it('admits the proxy DNS stub, the one direct dial', () => {
    const dns = spec(np).egress!.find((r) => ports(r).includes(DNS_STUB_PORT))!
    expect(dns.to).toEqual([{ podSelector: { matchLabels: { app: PROXY_APP_NAME } } }])
  })

  it('admits neither the project registry nor a vcluster API install-wide', () => {
    // This policy cannot express "the session's OWN project"; a blanket
    // rule would open every registry to every session (issue #17).
    const admitted = allPorts(spec(np).egress!)
    expect(admitted).not.toContain(5000)
    expect(admitted).not.toContain(8443)
  })
})

describe('buildSessionIngressLockNpManifest', () => {
  it('admits only the proxy on the streamd port, default-denying the rest', () => {
    const np = buildSessionIngressLockNpManifest()
    expect(spec(np).policyTypes).toEqual(['Ingress'])
    expect(spec(np).ingress).toEqual([{
      from: [{ podSelector: { matchLabels: { app: PROXY_APP_NAME } } }],
      ports: [{ protocol: 'TCP', port: POD_STREAM_PORT }],
    }])
  })
})

describe('buildProxyIngressNpManifest', () => {
  const np = buildProxyIngressNpManifest(NODES)

  it('admits the transparent ports from the NODE only — the forgery lock', () => {
    // Redirected traffic arrives from netd's Envoy in the host netns.
    // Envoy is the sole originator of PROXY-protocol preambles, so no
    // workload can inject a forged source.
    const nodeRule = spec(np).ingress!.find((r) => r.from?.some((p) => 'ipBlock' in p))!
    expect(ports(nodeRule)).toEqual([
      TRANSPARENT_HTTPS_PORT, TRANSPARENT_HTTP_PORT, TRANSPARENT_TUNNEL_PORT,
      PROXY_PORT, RELAY_PORT,
    ])
    const podRules = spec(np).ingress!.filter((r) => !r.from?.some((p) => 'ipBlock' in p))
    for (const rule of podRules) {
      expect(ports(rule)).toEqual([DNS_STUB_PORT])
    }
  })

  it('lets synced pods resolve through the outer stub', () => {
    const fromVcluster = spec(np).ingress!.find((r) =>
      r.from?.some((p) => 'namespaceSelector' in p))!
    expect(ports(fromVcluster)).toEqual([DNS_STUB_PORT])
  })
})

describe('buildEgressWorldDenyNpManifest', () => {
  const np = buildEgressWorldDenyNpManifest()

  it('default-denies egress with an empty rule list', () => {
    // Plain NP has no deny verb; an empty egress over a selector is how
    // NP expresses one.
    expect(np.metadata).toMatchObject({ name: EGRESS_WORLD_DENY_NAME })
    expect(spec(np).egress).toEqual([])
    expect(spec(np).policyTypes).toEqual(['Egress'])
  })

  it('exempts only the proxy, session pods, and builders', () => {
    // NotIn/DoesNotExist also match pods carrying no such label, so
    // anything added later stays covered by default.
    expect(spec(np).podSelector).toEqual({
      matchExpressions: [
        { key: 'app', operator: 'NotIn', values: [PROXY_APP_NAME] },
        { key: LABEL_SESSION_ID, operator: 'DoesNotExist' },
        { key: LABEL_ROLE, operator: 'NotIn', values: ['builder'] },
      ],
    })
  })
})

describe('buildVclusterEgressFloorNpManifest', () => {
  const np = buildVclusterEgressFloorNpManifest('test-ns-vc-demo', 'yvc-demo', NODES)

  it('selects on managed-by, the one label a tenant cannot forge or shed', () => {
    // Every yaac label propagates verbatim through the sync and is
    // therefore forgeable; only the syncer stamps this one.
    expect(np.metadata).toMatchObject({ namespace: 'test-ns-vc-demo' })
    expect(spec(np).podSelector).toEqual({
      matchExpressions: [{ key: LABEL_VCLUSTER_MANAGED_BY, operator: 'Exists' }],
    })
  })

  it('admits the listener range and nothing else world-ward', () => {
    const worldward = spec(np).egress!.filter((r) => r.to?.some((peer) => 'ipBlock' in peer))
    expect(worldward).toHaveLength(1)
    expect(worldward[0].ports).toEqual([{
      protocol: 'TCP', port: NETD_LISTENER_PORT_BASE, endPort: NETD_LISTENER_PORT_END,
    }])
  })

  it('admits sibling synced pods on any port, matched unforgeably', () => {
    const siblings = spec(np).egress!.find((r) =>
      r.ports === undefined && r.to?.some((p) =>
        JSON.stringify(p).includes(LABEL_VCLUSTER_MANAGED_BY)))
    expect(siblings).toBeDefined()
  })
})

describe('buildInnerProxyIngressNpManifest', () => {
  const np = buildInnerProxyIngressNpManifest('test-ns-vc-demo', 'yvc-demo', 'sess-1', NODES)

  it('admits the transparent ports from the node only, like the outer proxy', () => {
    const nodeRule = spec(np).ingress!.find((r) => r.from?.some((p) => 'ipBlock' in p))!
    expect(ports(nodeRule)).toEqual([
      TRANSPARENT_HTTPS_PORT, TRANSPARENT_HTTP_PORT, TRANSPARENT_TUNNEL_PORT, PROXY_PORT,
    ])
  })

  it('admits the relay from the OWNING session pod only', () => {
    // Other sessions stay locked out; the bearer auth line is the second
    // gate.
    const relay = spec(np).ingress!.find((r) => ports(r).includes(RELAY_PORT))!
    expect(JSON.stringify(relay.from)).toContain('sess-1')
  })

  it('selects the inner proxy by role', () => {
    expect(spec(np).podSelector).toEqual({ matchLabels: { [LABEL_ROLE]: ROLE_INNER_PROXY } })
  })
})

describe('buildInnerSessionIngressLockNpManifest', () => {
  it('admits streamd dials from this vcluster\'s inner proxies only', () => {
    const np = buildInnerSessionIngressLockNpManifest('test-ns-vc-demo', 'yvc-demo')
    expect(spec(np).ingress).toEqual([{
      from: [{
        podSelector: {
          matchLabels: { [LABEL_VCLUSTER_MANAGED_BY]: 'yvc-demo', [LABEL_ROLE]: ROLE_INNER_PROXY },
        },
      }],
      ports: [{ protocol: 'TCP', port: POD_STREAM_PORT }],
    }])
  })
})

describe('buildVclusterControlPlaneNpManifest', () => {
  const np = buildVclusterControlPlaneNpManifest(
    'test-ns-vc-demo', 'yvc-demo', { app: PROXY_APP_NAME }, APISERVERS,
  )

  it('excludes synced pods from the selector, so the grant cannot be inherited', () => {
    // A tenant can create a synced pod labelled app=vcluster,
    // release=<vc> — those labels propagate — and NP unions allows, so
    // without the guard it would inherit this policy's apiserver egress.
    expect(spec(np).podSelector).toEqual({
      matchLabels: { app: 'vcluster', release: 'yvc-demo' },
      matchExpressions: [{ key: LABEL_VCLUSTER_MANAGED_BY, operator: 'DoesNotExist' }],
    })
  })

  it('grants the apiserver endpoints, not the Service VIP', () => {
    expect(spec(np).egress![0].to).toEqual([{ ipBlock: { cidr: '10.89.0.7/32' } }])
  })

  it('grants no world-ward egress beyond the apiserver', () => {
    const ipBlocks = spec(np).egress!.flatMap((r) => r.to ?? []).filter((p) => 'ipBlock' in p)
    expect(ipBlocks).toEqual([{ ipBlock: { cidr: '10.89.0.7/32' } }])
  })
})

describe('innerProjectionLabels', () => {
  it('stamps the install hash when one is given', () => {
    expect(innerProjectionLabels('h1')).toEqual({
      app: PROXY_APP_NAME, [LABEL_DATA_DIR_HASH]: 'h1',
    })
  })

  it('omits the hash when there is none', () => {
    expect(innerProjectionLabels()).toEqual({ app: PROXY_APP_NAME })
  })
})
