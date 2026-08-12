import { describe, it, expect, vi, beforeEach } from 'vitest'

// kubectl is the process boundary: every manifest the activator applies and
// every list it reads goes through here. Nothing inside features/cluster is
// mocked, so cluster-cidrs resolves the node/apiserver ipBlocks for real off
// the `get nodes` / `get endpoints` responses staged below.
vi.mock('#runtime/k8s/substrate/kubectl', () => ({
  isKubectlAbsentError: vi.fn(() => false),
  kubectlErrorSummary: vi.fn((e: unknown) => String(e)),
  k8sNamespace: vi.fn(() => 'test-ns'),
  dataDirHash: vi.fn(() => 'ddh16'),
  kubectlApply: vi.fn().mockResolvedValue(undefined),
  kubectlGetJson: vi.fn(),
  kubectlWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  execFileAsync: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

import {
  buildVclusterSleepEndpointSliceManifest,
  ensureActivator,
  getActivatorPodIp,
  vclusterSleepSliceName,
} from '#runtime/k8s/cluster'
import { resetClusterCidrCache } from '#runtime/k8s/cluster/cluster-cidrs'
import { LABEL_VCLUSTER_MANAGED_BY, VCLUSTER_API_PORT } from '#runtime/k8s/substrate/pods'
import { kubectlApply, kubectlGetJson, kubectlWithRetry } from '#runtime/k8s/substrate/kubectl'

const mockApply = vi.mocked(kubectlApply)
const mockGetJson = vi.mocked(kubectlGetJson)
const mockRetry = vi.mocked(kubectlWithRetry)

const ACTIVATOR_APP_NAME = 'yaac-vc-activator'
const VC = 'yvc-0a1b2c3d'
const VCNS = 'test-ns-vc-0a1b2c3d'
const LABELS = { 'yaac.vcluster': VC }
const NODE_IP = '10.89.0.7'

interface Manifest {
  kind: string
  metadata: { name: string; namespace: string; labels?: Record<string, string> }
}

/** Answer the two cluster-cidrs reads so the NetworkPolicy renders for real. */
function stageCidrReads(): void {
  mockGetJson.mockImplementation((args: string[]) => {
    if (args[1] === 'nodes') {
      return Promise.resolve({
        items: [{ status: { addresses: [{ type: 'InternalIP', address: NODE_IP }] } }],
      })
    }
    if (args[1] === 'endpoints') {
      return Promise.resolve({ subsets: [{ addresses: [{ ip: NODE_IP }] }] })
    }
    return Promise.resolve({ items: [] })
  })
}

function applied(kind: string): Manifest | undefined {
  return mockApply.mock.calls.map((c) => c[0] as Manifest).find((m) => m.kind === kind)
}

beforeEach(() => {
  vi.clearAllMocks()
  resetClusterCidrCache()
})

describe('vclusterSleepSliceName', () => {
  it('derives the per-vcluster interception slice name', () => {
    expect(vclusterSleepSliceName(VC)).toBe(`yaac-sleep-${VC}`)
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
  it('applies SA → Deployment → NetworkPolicy, then waits for rollout', async () => {
    stageCidrReads()
    await ensureActivator('yaac-proxy:abc123')

    const kinds = mockApply.mock.calls.map((c) => (c[0] as Manifest).kind)
    expect(kinds).toEqual(['ServiceAccount', 'Deployment', 'NetworkPolicy'])
    expect(mockRetry).toHaveBeenCalledWith(
      expect.arrayContaining(['rollout', 'status', `deployment/${ACTIVATOR_APP_NAME}`]),
      expect.anything(),
    )
  })

  it('runs the caller\'s proxy tag, registry-qualified, on runc under its own SA', async () => {
    stageCidrReads()
    await ensureActivator('yaac-proxy:abc123')

    expect(applied('ServiceAccount')?.metadata).toMatchObject({
      name: ACTIVATOR_APP_NAME, namespace: 'test-ns',
    })
    const dep = applied('Deployment') as unknown as {
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
    expect(dep.metadata.namespace).toBe('test-ns')
    const pod = dep.spec.template.spec
    expect(pod.serviceAccountName).toBe(ACTIVATOR_APP_NAME)
    // Trusted yaac infra: no runtimeClassName → runc, like the proxy and
    // the vcluster control plane.
    expect(pod.runtimeClassName).toBeUndefined()
    const c = pod.containers[0]
    // The tag arrives from the session create flow; the activator only
    // qualifies it with the local registry.
    expect(c.image).toMatch(/\/yaac-proxy:abc123$/)
    expect(c.command).toEqual(['./node_modules/.bin/tsx', 'activator-main.ts'])
    expect(c.env).toContainEqual({ name: 'YAAC_INSTALL_NAMESPACE', value: 'test-ns' })
    expect(c.env).toContainEqual({ name: 'ACTIVATOR_PORT', value: String(VCLUSTER_API_PORT) })
    expect(c.readinessProbe.tcpSocket.port).toBe(VCLUSTER_API_PORT)
  })

  it('locks the policy to session pods and the node, egressing only to the apiserver', async () => {
    stageCidrReads()
    await ensureActivator('yaac-proxy:abc123')

    const np = applied('NetworkPolicy') as unknown as {
      spec: {
        podSelector: { matchLabels: Record<string, string> }
        ingress: Array<Record<string, unknown>>
        egress: Array<Record<string, unknown>>
        policyTypes: string[]
      }
    }
    expect(np.spec.podSelector.matchLabels).toEqual({ app: ACTIVATOR_APP_NAME })
    // Plain NP has no selector for the host network namespace, so the node
    // is named by address — resolved here through the real cluster-cidrs
    // read of `get nodes`.
    expect(np.spec.ingress[0]).toMatchObject({ from: [{ ipBlock: { cidr: `${NODE_IP}/32` } }] })
    expect(JSON.stringify(np.spec.ingress[1])).toContain('yaac.session-id')
    expect(JSON.stringify(np.spec.ingress)).toContain(String(VCLUSTER_API_PORT))

    expect(np.spec.egress[0]).toEqual({ to: [{ ipBlock: { cidr: `${NODE_IP}/32` } }] })
    const cp = JSON.stringify(np.spec.egress[1])
    expect(cp).toContain('vcluster')
    // The unforgeable exclusion: a synced pod forging `app=vcluster` must
    // not receive proxied wake traffic.
    expect(cp).toContain('DoesNotExist')
    expect(cp).toContain(LABEL_VCLUSTER_MANAGED_BY)
    // Both types declared, so egress is default-denied.
    expect(np.spec.policyTypes).toEqual(['Ingress', 'Egress'])
  })

  it('falls back to the node set when the apiserver Endpoints object is empty', async () => {
    mockGetJson.mockImplementation((args: string[]) => {
      if (args[1] === 'nodes') {
        return Promise.resolve({
          items: [{ status: { addresses: [{ type: 'InternalIP', address: NODE_IP }] } }],
        })
      }
      return Promise.resolve({ subsets: [] })
    })
    await ensureActivator('yaac-proxy:abc123')
    const np = applied('NetworkPolicy') as unknown as {
      spec: { egress: Array<{ to?: Array<{ ipBlock?: { cidr: string } }> }> }
    }
    expect(np.spec.egress[0].to?.[0].ipBlock?.cidr).toBe(`${NODE_IP}/32`)
  })

  it('refuses to render a policy when no node InternalIP resolves', async () => {
    mockGetJson.mockResolvedValue({ items: [] })
    await expect(ensureActivator('yaac-proxy:abc123'))
      .rejects.toThrow(/could not resolve any node InternalIP/)
  })
})
