import { describe, it, expect, beforeEach, vi } from 'vitest'

// kubectl is the process boundary: `execFileAsync` is the podman inspect the
// IP discovery runs, `kubectlApply` every manifest written. `ensureNamespace`
// is a sibling and runs for real behind the same mock, so its Namespace apply
// shows up in the recorded calls below.
vi.mock('#platform/k8s/kubectl', () => ({
  k8sNamespace: vi.fn(() => 'test-ns'),
  kubectlApply: vi.fn().mockResolvedValue(undefined),
  execFileAsync: vi.fn(),
}))

import { ensureRegistryClusterService, registryClusterHost } from '#features/cluster'
import { execFileAsync, kubectlApply } from '#platform/k8s/kubectl'

const mockApply = vi.mocked(kubectlApply)
const mockRun = vi.mocked(execFileAsync)

const HOST = 'yaac-registry.test-ns.svc.cluster.local:5000'

function stageNetworks(networks: Record<string, { IPAddress?: string }>): void {
  mockRun.mockResolvedValue({ stdout: JSON.stringify(networks), stderr: '' })
}

function appliedKinds(): string[] {
  return mockApply.mock.calls.map((c) => (c[0] as { kind: string }).kind)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('registryClusterHost', () => {
  it('is the namespaced FQDN on the container-internal port', () => {
    expect(registryClusterHost()).toBe(HOST)
  })
})

describe('ensureRegistryClusterService', () => {
  it('discovers the kind-network IP, then writes namespace + Service + EndpointSlice', async () => {
    stageNetworks({ kind: { IPAddress: '10.89.0.7' }, podman: { IPAddress: '10.88.0.2' } })

    await expect(ensureRegistryClusterService()).resolves.toBe(HOST)

    expect(mockRun).toHaveBeenCalledWith('podman', [
      'inspect', 'yaac-registry', '--format', '{{json .NetworkSettings.Networks}}',
    ])
    expect(appliedKinds()).toEqual(['Namespace', 'Service', 'EndpointSlice'])

    // Selectorless Service: the backend is a podman container, not a pod, so
    // kube-proxy programs the DNAT from the hand-written slice instead.
    const svc = mockApply.mock.calls[1][0] as {
      metadata: { name: string; namespace: string }
      spec: { selector?: unknown; ports: Array<{ port: number; targetPort: number; protocol: string }> }
    }
    expect(svc.metadata).toEqual({ name: 'yaac-registry', namespace: 'test-ns' })
    expect(svc.spec.selector).toBeUndefined()
    expect(svc.spec.ports).toEqual([{ port: 5000, targetPort: 5000, protocol: 'TCP' }])

    const slice = mockApply.mock.calls[2][0] as {
      metadata: { name: string; namespace: string; labels: Record<string, string> }
      addressType: string
      ports: unknown[]
      endpoints: Array<{ addresses: string[]; conditions: { ready: boolean } }>
    }
    // service-name is what binds a manual EndpointSlice to its Service.
    expect(slice.metadata.labels).toEqual({ 'kubernetes.io/service-name': 'yaac-registry' })
    expect(slice.metadata.namespace).toBe('test-ns')
    expect(slice.addressType).toBe('IPv4')
    // The kind-network address, not the podman-network one.
    expect(slice.endpoints).toEqual([{ addresses: ['10.89.0.7'], conditions: { ready: true } }])
    expect(slice.ports).toEqual([{ name: '', port: 5000, protocol: 'TCP' }])
  })

  it('points at cluster setup when the registry is off the kind network', async () => {
    stageNetworks({ podman: { IPAddress: '10.88.0.2' } })
    await expect(ensureRegistryClusterService())
      .rejects.toThrow(/yaac cluster setup --repair/)
    expect(mockApply).not.toHaveBeenCalled()
  })

  it('points at cluster check when the registry container is missing', async () => {
    mockRun.mockRejectedValue(new Error('no such container'))
    await expect(ensureRegistryClusterService())
      .rejects.toThrow(/yaac cluster check/)
    expect(mockApply).not.toHaveBeenCalled()
  })
})
