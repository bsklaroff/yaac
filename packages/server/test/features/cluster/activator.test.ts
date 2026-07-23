import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('#platform/k8s/kubectl', () => ({
  k8sNamespace: vi.fn(() => 'test-ns'),
  dataDirHash: vi.fn(() => 'ddh16'),
  kubectlApply: vi.fn().mockResolvedValue(undefined),
  kubectlGetJson: vi.fn(),
  kubectlWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  execFileAsync: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

vi.mock('#features/cluster/registry', () => ({
  registryHost: vi.fn(() => 'localhost:5001'),
  registryRef: vi.fn((tag: string) => `localhost:5001/${tag}`),
}))

vi.mock('#features/sessions/egress/proxy-client', () => ({
  resolveProxyImageTag: vi.fn().mockResolvedValue('yaac-proxy:abc123'),
}))

import {
  ACTIVATOR_APP_NAME,
  buildActivatorCnpManifest,
  buildActivatorDeploymentManifest,
  buildActivatorServiceAccountManifest,
  buildActivatorVclusterRoleBindingManifest,
  buildActivatorVclusterRoleManifest,
  buildVclusterSleepEndpointSliceManifest,
  ensureActivator,
  getActivatorPodIp,
  vclusterSleepSliceName,
} from '#features/cluster/activator'
import { VCLUSTER_API_PORT } from '#platform/k8s/pods'
import { kubectlApply, kubectlGetJson, kubectlWithRetry } from '#platform/k8s/kubectl'

const mockApply = vi.mocked(kubectlApply)
const mockGetJson = vi.mocked(kubectlGetJson)
const mockRetry = vi.mocked(kubectlWithRetry)

const VC = 'yvc-0a1b2c3d'
const VCNS = 'test-ns-vc-0a1b2c3d'
const LABELS = { 'yaac.vcluster': VC }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('vclusterSleepSliceName', () => {
  it('derives the per-vcluster interception slice name', () => {
    expect(vclusterSleepSliceName(VC)).toBe(`yaac-sleep-${VC}`)
  })
})

describe('buildActivatorServiceAccountManifest', () => {
  it('creates the SA in the install namespace', () => {
    expect(buildActivatorServiceAccountManifest()).toMatchObject({
      kind: 'ServiceAccount',
      metadata: { name: ACTIVATOR_APP_NAME, namespace: 'test-ns' },
    })
  })
})

describe('buildActivatorDeploymentManifest', () => {
  it('runs the proxy image with the activator entrypoint on runc', () => {
    const m = buildActivatorDeploymentManifest('reg/yaac-proxy:abc') as {
      metadata: { namespace: string }
      spec: {
        template: {
          spec: {
            serviceAccountName: string
            runtimeClassName?: string
            containers: Array<{
              image: string
              command: string[]
              env: Array<{ name: string; value: string }>
              readinessProbe: { tcpSocket: { port: number } }
            }>
          }
        }
      }
    }
    expect(m.metadata.namespace).toBe('test-ns')
    const pod = m.spec.template.spec
    expect(pod.serviceAccountName).toBe(ACTIVATOR_APP_NAME)
    // Trusted yaac infra: no runtimeClassName → runc, like the proxy and
    // the vcluster control plane.
    expect(pod.runtimeClassName).toBeUndefined()
    const c = pod.containers[0]
    expect(c.image).toBe('reg/yaac-proxy:abc')
    expect(c.command).toEqual(['./node_modules/.bin/tsx', 'activator-main.ts'])
    expect(c.env).toContainEqual({ name: 'YAAC_INSTALL_NAMESPACE', value: 'test-ns' })
    expect(c.env).toContainEqual({ name: 'ACTIVATOR_PORT', value: String(VCLUSTER_API_PORT) })
    expect(c.readinessProbe.tcpSocket.port).toBe(VCLUSTER_API_PORT)
  })
})

describe('buildActivatorCnpManifest', () => {
  it('locks ingress to session pods + host (probe)', () => {
    const m = buildActivatorCnpManifest() as {
      kind: string
      spec: {
        endpointSelector: { matchLabels: Record<string, string> }
        ingress: Array<Record<string, unknown>>
      }
    }
    expect(m.kind).toBe('CiliumNetworkPolicy')
    expect(m.spec.endpointSelector.matchLabels).toEqual({ app: ACTIVATOR_APP_NAME })
    expect(m.spec.ingress[0]).toMatchObject({ fromEntities: ['host'] })
    expect(JSON.stringify(m.spec.ingress[1])).toContain('yaac.session-id')
    expect(JSON.stringify(m.spec.ingress)).toContain(String(VCLUSTER_API_PORT))
  })

  it('allows egress only to the host API and unforgeable control-plane pods', () => {
    const m = buildActivatorCnpManifest() as {
      spec: {
        egress: Array<{
          toEntities?: string[]
          toEndpoints?: Array<{
            matchLabels?: Record<string, string>
            matchExpressions?: Array<{ key: string; operator: string }>
          }>
          toPorts?: Array<{ ports: Array<{ port: string }> }>
        }>
      }
    }
    // The explicit allow is load-bearing: the install-wide world-deny
    // (an egressDeny) selects the activator, and any egress(-deny)
    // section flips the endpoint into egress default-deny.
    expect(m.spec.egress[0]).toEqual({ toEntities: ['kube-apiserver', 'host'] })
    const cp = m.spec.egress[1]
    expect(cp.toEndpoints?.[0].matchLabels).toEqual({ app: 'vcluster' })
    // Cross-namespace (the namespace key) and excluding synced pods by
    // the one label a tenant cannot shed.
    expect(cp.toEndpoints?.[0].matchExpressions).toEqual([
      { key: 'k8s:io.kubernetes.pod.namespace', operator: 'Exists' },
      { key: 'vcluster.loft.sh/managed-by', operator: 'DoesNotExist' },
    ])
    expect(cp.toPorts?.[0].ports).toEqual([{ port: String(VCLUSTER_API_PORT), protocol: 'TCP' }])
    expect(m.spec.egress).toHaveLength(2)
  })
})

describe('per-vcluster RBAC', () => {
  it('grants only the wake-shaped verbs, resource-scoped where possible', () => {
    const role = buildActivatorVclusterRoleManifest(VC, VCNS, LABELS) as {
      metadata: { namespace: string; labels: Record<string, string> }
      rules: Array<{ resources: string[]; verbs: string[]; resourceNames?: string[] }>
    }
    expect(role.metadata.namespace).toBe(VCNS)
    expect(role.metadata.labels).toEqual(LABELS)
    expect(role.rules).toContainEqual(expect.objectContaining({
      resources: ['secrets'], verbs: ['get'], resourceNames: [`${VC}-certs`],
    }))
    expect(role.rules).toContainEqual(expect.objectContaining({
      resources: ['deployments'], verbs: ['get'], resourceNames: [VC],
    }))
    expect(role.rules).toContainEqual(expect.objectContaining({
      resources: ['deployments/scale'], resourceNames: [VC],
    }))
    // Slice writes are name-scoped to the interception slice; list (the
    // wake's routing gate on the controller slice) cannot be.
    expect(role.rules).toContainEqual(expect.objectContaining({
      resources: ['endpointslices'], verbs: ['get', 'delete'],
      resourceNames: [vclusterSleepSliceName(VC)],
    }))
    expect(role.rules).toContainEqual(expect.objectContaining({
      resources: ['endpointslices'], verbs: ['list'],
    }))
    // Nothing beyond the wake surface: no secret list, no pod writes.
    expect(role.rules).toContainEqual(expect.objectContaining({
      resources: ['pods'], verbs: ['get', 'list'],
    }))
  })

  it('binds the install-namespace SA into the vcluster namespace', () => {
    const rb = buildActivatorVclusterRoleBindingManifest(VCNS, LABELS) as {
      metadata: { namespace: string }
      roleRef: { name: string }
      subjects: Array<{ kind: string; name: string; namespace: string }>
    }
    expect(rb.metadata.namespace).toBe(VCNS)
    expect(rb.roleRef.name).toBe(ACTIVATOR_APP_NAME)
    expect(rb.subjects).toEqual([
      { kind: 'ServiceAccount', name: ACTIVATOR_APP_NAME, namespace: 'test-ns' },
    ])
  })
})

describe('buildVclusterSleepEndpointSliceManifest', () => {
  it('attaches to the API Service under a foreign managed-by, naming all three ports', () => {
    const m = buildVclusterSleepEndpointSliceManifest(VC, VCNS, LABELS, '10.244.0.9') as {
      kind: string
      metadata: { name: string; namespace: string; labels: Record<string, string> }
      addressType: string
      endpoints: Array<{ addresses: string[]; conditions: { ready: boolean } }>
      ports: Array<{ name: string; port: number; protocol: string }>
    }
    expect(m.kind).toBe('EndpointSlice')
    expect(m.metadata.name).toBe(vclusterSleepSliceName(VC))
    expect(m.metadata.namespace).toBe(VCNS)
    // service-name attaches it; the foreign managed-by keeps the
    // built-in endpointslice controller's hands off it.
    expect(m.metadata.labels['kubernetes.io/service-name']).toBe(VC)
    expect(m.metadata.labels['endpointslice.kubernetes.io/managed-by']).toBe('yaac.dev')
    expect(m.metadata.labels['yaac.vcluster']).toBe(VC)
    expect(m.addressType).toBe('IPv4')
    expect(m.endpoints).toEqual([{ addresses: ['10.244.0.9'], conditions: { ready: true } }])
    // By-name port matching: naming only `https` would leave 8443 (the
    // port that matters) unrouted.
    expect(m.ports.map((p) => p.name).sort()).toEqual(['https', 'kubelet', 'yaac-api'])
    for (const p of m.ports) {
      expect(p.port).toBe(VCLUSTER_API_PORT)
      expect(p.protocol).toBe('TCP')
    }
  })
})

describe('getActivatorPodIp', () => {
  it('returns the running pod IP, skipping terminating pods', async () => {
    mockGetJson.mockResolvedValue({
      items: [
        {
          metadata: { deletionTimestamp: '2026-07-23T00:00:00Z' },
          status: { phase: 'Running', podIP: '10.244.0.1' },
        },
        { status: { phase: 'Running', podIP: '10.244.0.2' } },
      ],
    })
    await expect(getActivatorPodIp()).resolves.toBe('10.244.0.2')
    expect(mockGetJson).toHaveBeenCalledWith([
      'get', 'pods', '-n', 'test-ns', '-l', `app=${ACTIVATOR_APP_NAME}`,
    ])
  })

  it('throws when no running activator pod exists', async () => {
    mockGetJson.mockResolvedValue({ items: [{ status: { phase: 'Pending' } }] })
    await expect(getActivatorPodIp()).rejects.toThrow(/no running activator pod/)
  })
})

describe('ensureActivator', () => {
  it('applies SA → Deployment → ingress CNP with the registry proxy image, then waits for rollout', async () => {
    await ensureActivator()
    const kinds = mockApply.mock.calls.map((c) => (c[0] as { kind: string }).kind)
    expect(kinds).toEqual(['ServiceAccount', 'Deployment', 'CiliumNetworkPolicy'])
    const dep = mockApply.mock.calls
      .map((c) => c[0] as { kind: string; spec?: { template: { spec: { containers: Array<{ image: string }> } } } })
      .find((m) => m.kind === 'Deployment')
    expect(dep?.spec?.template.spec.containers[0].image).toBe('localhost:5001/yaac-proxy:abc123')
    expect(mockRetry).toHaveBeenCalledWith(
      expect.arrayContaining(['rollout', 'status', `deployment/${ACTIVATOR_APP_NAME}`]),
      expect.anything(),
    )
  })
})
