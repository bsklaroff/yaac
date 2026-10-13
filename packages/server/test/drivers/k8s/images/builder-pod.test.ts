/**
 * builder-pod's barrel function: the leaked-pod reaper (a reconcile step).
 * The rest of the module is covered through `ensureImage` in
 * build-coordinator.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'


vi.mock('#drivers/k8s/cluster/cluster-cidrs', () => ({
  nodeIpBlocks: vi.fn().mockResolvedValue(['10.89.0.7/32']),
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
  it('deletes every builder pod of this install and nothing else', async () => {
    const pod = (name: string, labels: Record<string, string>) =>
      ({ apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: k8sNamespace(), labels } })
    fakeCluster.seed(
      pod('leaked', { 'yaac.role': 'builder', 'yaac.install-id': installId() }),
      pod('other-install', { 'yaac.role': 'builder', 'yaac.install-id': 'x' }),
      pod('workspace', { 'yaac.install-id': installId() }),
    )
    await deleteLeakedBuilderPods()
    expect(fakeCluster.objects('Pod').map((p) => p.metadata.name).sort()).toEqual(['other-install', 'workspace'])
  })
})
