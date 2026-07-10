import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@yaac/server/lib/k8s/kubectl', () => ({
  kubectlApply: vi.fn().mockResolvedValue(undefined),
  kubectlWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

import {
  buildCiliumEnvoyConfigCrdManifest,
  buildCiliumNetworkPolicyCrdManifest,
  ensureCiliumCrds,
} from '@yaac/server/lib/k8s/cilium-crds'
import { kubectlApply, kubectlWithRetry } from '@yaac/server/lib/k8s/kubectl'

const mockApply = vi.mocked(kubectlApply)
const mockRetry = vi.mocked(kubectlWithRetry)

interface Crd {
  apiVersion: string
  kind: string
  metadata: { name: string }
  spec: {
    group: string
    scope: string
    names: { kind: string; plural: string; singular: string; shortNames: string[] }
    versions: Array<{ name: string; served: boolean; storage: boolean; schema: { openAPIV3Schema: Record<string, unknown> } }>
  }
}

describe('Cilium CRD builders (nested vcluster install)', () => {
  it('CiliumEnvoyConfig CRD: cilium.io/v2, namespaced, permissive schema', () => {
    const m = buildCiliumEnvoyConfigCrdManifest() as unknown as Crd
    expect(m.apiVersion).toBe('apiextensions.k8s.io/v1')
    expect(m.metadata.name).toBe('ciliumenvoyconfigs.cilium.io')
    expect(m.spec.group).toBe('cilium.io')
    expect(m.spec.scope).toBe('Namespaced')
    expect(m.spec.names.kind).toBe('CiliumEnvoyConfig')
    expect(m.spec.names.plural).toBe('ciliumenvoyconfigs')
    const v = m.spec.versions[0]
    expect({ name: v.name, served: v.served, storage: v.storage }).toEqual({ name: 'v2', served: true, storage: true })
    // Permissive — accepts yaac's CEC without vendoring Cilium's full schema.
    expect(v.schema.openAPIV3Schema).toEqual({ type: 'object', 'x-kubernetes-preserve-unknown-fields': true })
  })

  it('CiliumNetworkPolicy CRD: correct names', () => {
    const m = buildCiliumNetworkPolicyCrdManifest() as unknown as Crd
    expect(m.metadata.name).toBe('ciliumnetworkpolicies.cilium.io')
    expect(m.spec.names.kind).toBe('CiliumNetworkPolicy')
    expect(m.spec.names.plural).toBe('ciliumnetworkpolicies')
    expect(m.spec.names.shortNames).toContain('cnp')
  })
})

describe('ensureCiliumCrds', () => {
  beforeEach(() => vi.clearAllMocks())

  it('applies both CRDs then waits for them to be Established', async () => {
    await ensureCiliumCrds()
    const applied = mockApply.mock.calls.map(([m]) => (m as { metadata: { name: string } }).metadata.name)
    expect(applied).toEqual(['ciliumenvoyconfigs.cilium.io', 'ciliumnetworkpolicies.cilium.io'])
    const wait = mockRetry.mock.calls.map(([args]) => args.join(' '))[0]
    expect(wait).toContain('wait --for=condition=Established')
    expect(wait).toContain('crd/ciliumenvoyconfigs.cilium.io')
    expect(wait).toContain('crd/ciliumnetworkpolicies.cilium.io')
  })
})
