/**
 * builder-pod's barrel function: the leaked-pod reaper, run at driver
 * start. The rest of the module is covered through `buildImageLayers` in
 * build-coordinator.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'


vi.mock('#drivers/k8s/cluster/cluster-cidrs', () => ({
  nodeIpBlocks: vi.fn().mockResolvedValue(['10.89.0.7/32']),
  nodeAddressBlocks: vi.fn().mockResolvedValue(['10.89.0.7/32']),
  clusterDnsCidrs: vi.fn().mockResolvedValue(['10.96.0.10/32']),
  resetClusterCidrCache: vi.fn(),
}))

// Faked so the builder path does not depend on an apiserver.
const mockVapAvailable = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/cluster/proxy-apply', async (importOriginal) => ({
  ...(await importOriginal<typeof proxyApplyModule>()),
  vapAvailable: mockVapAvailable,
}))
import type * as proxyApplyModule from '#drivers/k8s/cluster/proxy-apply'

import { deleteLeakedBuilderPods } from '#drivers/k8s/images'
import { installId, k8sNamespace } from '#drivers/k8s/substrate'
import { fakeCluster } from '@yaac/test-utils/k8s-stub'

beforeEach(() => {
  vi.clearAllMocks()
  mockVapAvailable.mockResolvedValue(true)
})

describe('deleteLeakedBuilderPods', () => {
  it('deletes the builder pods and build registrations of this install older than this server, and nothing else', async () => {
    const before = '2026-01-01T00:00:00Z'
    const obj = (kind: string, name: string, labels: Record<string, string>, creationTimestamp?: string) =>
      ({ apiVersion: 'v1', kind, metadata: { name, namespace: k8sNamespace(), labels, ...(creationTimestamp ? { creationTimestamp } : {}) } })
    const builder = { 'yaac.role': 'builder', 'yaac.install-id': installId() }
    const registration = { 'yaac.proxy-input': 'registration', 'yaac.build-id': 'b1' }
    fakeCluster.seed(
      obj('Pod', 'leaked', builder, before),
      // A build this server started before the reaper ran.
      obj('Pod', 'this-server', builder),
      obj('Pod', 'other-install', { 'yaac.role': 'builder', 'yaac.install-id': 'x' }, before),
      obj('Pod', 'workspace', { 'yaac.install-id': installId() }, before),
      obj('ConfigMap', 'leaked-registration', registration, before),
      obj('ConfigMap', 'this-server-registration', registration),
      obj('ConfigMap', 'workspace-registration', { 'yaac.proxy-input': 'registration', 'yaac.workspace-id': 'w' }, before),
    )
    await deleteLeakedBuilderPods()
    expect(fakeCluster.objects('Pod').map((p) => p.metadata.name).sort()).toEqual(['other-install', 'this-server', 'workspace'])
    expect(fakeCluster.objects('ConfigMap').map((c) => c.metadata.name).sort())
      .toEqual(['this-server-registration', 'workspace-registration'])
  })
})
