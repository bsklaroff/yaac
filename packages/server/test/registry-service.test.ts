import { describe, it, expect, beforeEach, vi } from 'vitest'
import type * as kubectlModule from '#lib/k8s/kubectl'

vi.mock('#lib/k8s/kubectl', async (importOriginal) => ({
  ...(await importOriginal<typeof kubectlModule>()),
  k8sNamespace: () => 'test-ns',
}))

import {
  REGISTRY_SERVICE_NAME,
  REGISTRY_SERVICE_PORT,
  buildRegistryEndpointSliceManifest,
  buildRegistryServiceManifest,
  discoverRegistryKindIp,
  ensureRegistryClusterService,
  registryClusterHost,
  type RegistryServiceDeps,
} from '#lib/k8s/registry-service'

function makeDeps(over: Partial<RegistryServiceDeps> = {}): RegistryServiceDeps & {
  run: ReturnType<typeof vi.fn>
  apply: ReturnType<typeof vi.fn>
  namespace: ReturnType<typeof vi.fn>
} {
  return {
    run: vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        kind: { IPAddress: '10.89.0.7' },
        podman: { IPAddress: '10.88.0.2' },
      }),
    }),
    apply: vi.fn().mockResolvedValue(undefined),
    namespace: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('registryClusterHost', () => {
  it('is the namespaced FQDN on the container-internal port', () => {
    expect(registryClusterHost()).toBe('yaac-registry.test-ns.svc.cluster.local:5000')
  })
})

describe('discoverRegistryKindIp', () => {
  it('reads the kind-network IP from podman inspect', async () => {
    const deps = makeDeps()
    expect(await discoverRegistryKindIp(deps)).toBe('10.89.0.7')
    expect(deps.run).toHaveBeenCalledWith('podman', [
      'inspect', 'yaac-registry', '--format', '{{json .NetworkSettings.Networks}}',
    ])
  })

  it('points at cluster setup when the registry is off the kind network', async () => {
    const deps = makeDeps({
      run: vi.fn().mockResolvedValue({
        stdout: JSON.stringify({ podman: { IPAddress: '10.88.0.2' } }),
      }),
    })
    await expect(discoverRegistryKindIp(deps))
      .rejects.toThrow(/yaac cluster setup --repair/)
  })

  it('points at cluster check when the container is missing', async () => {
    const deps = makeDeps({
      run: vi.fn().mockRejectedValue(new Error('no such container')),
    })
    await expect(discoverRegistryKindIp(deps))
      .rejects.toThrow(/yaac cluster check/)
  })
})

describe('manifests', () => {
  it('builds a selectorless Service on port 5000', () => {
    const m = buildRegistryServiceManifest() as {
      metadata: { name: string; namespace: string }
      spec: { selector?: unknown; ports: Array<{ port: number; targetPort: number }> }
    }
    expect(m.metadata).toEqual({ name: REGISTRY_SERVICE_NAME, namespace: 'test-ns' })
    expect(m.spec.selector).toBeUndefined()
    expect(m.spec.ports).toEqual([{
      port: REGISTRY_SERVICE_PORT,
      targetPort: REGISTRY_SERVICE_PORT,
      protocol: 'TCP',
    }])
  })

  it('binds the EndpointSlice to the Service with the discovered IP', () => {
    const m = buildRegistryEndpointSliceManifest('10.89.0.7') as {
      metadata: { name: string; namespace: string; labels: Record<string, string> }
      addressType: string
      ports: unknown[]
      endpoints: Array<{ addresses: string[]; conditions: { ready: boolean } }>
    }
    expect(m.metadata.labels).toEqual({ 'kubernetes.io/service-name': REGISTRY_SERVICE_NAME })
    expect(m.addressType).toBe('IPv4')
    expect(m.endpoints).toEqual([{ addresses: ['10.89.0.7'], conditions: { ready: true } }])
    expect(m.ports).toEqual([{ name: '', port: REGISTRY_SERVICE_PORT, protocol: 'TCP' }])
  })
})

describe('ensureRegistryClusterService', () => {
  it('ensures the namespace then applies Service + EndpointSlice', async () => {
    const deps = makeDeps()
    const host = await ensureRegistryClusterService(deps)
    expect(host).toBe('yaac-registry.test-ns.svc.cluster.local:5000')
    expect(deps.namespace).toHaveBeenCalled()
    const kinds = deps.apply.mock.calls.map((c) => (c[0] as { kind: string }).kind)
    expect(kinds).toEqual(['Service', 'EndpointSlice'])
    const slice = deps.apply.mock.calls[1][0] as {
      endpoints: Array<{ addresses: string[] }>
    }
    expect(slice.endpoints[0].addresses).toEqual(['10.89.0.7'])
  })
})
