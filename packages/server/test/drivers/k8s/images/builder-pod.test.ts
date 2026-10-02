/**
 * builder-pod's barrel function: the leaked-pod reaper (a reconcile step).
 * The rest of the module is covered through `ensureImage` in
 * build-coordinator.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type * as kubectlModule from '#drivers/k8s/substrate/kubectl'
import type * as registryModule from '#drivers/k8s/container/registry'
import type * as runtimeModule from '#drivers/k8s/container/runtime'

vi.mock('#log', () => ({ serverLog: vi.fn(), pipeToServerLog: vi.fn() }))

const mockKubectlApply = vi.hoisted(() => vi.fn())
const mockKubectlWithRetry = vi.hoisted(() => vi.fn())
const mockKubectlGetJson = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/substrate/kubectl', async (importOriginal) => ({
  ...(await importOriginal<typeof kubectlModule>()),
  k8sNamespace: () => 'test-ns',
  dataDirHash: () => 'ddh0000000000000',
  kubectlApply: mockKubectlApply,
  kubectlWithRetry: mockKubectlWithRetry,
  kubectlGetJson: mockKubectlGetJson,
  ensureKubernetes: vi.fn(),
}))

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

const mockImageExists = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/container/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof runtimeModule>()),
  imageExists: mockImageExists,
}))

const mockRegistryHasTag = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/container/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof registryModule>()),
  registryHasTag: mockRegistryHasTag,
  registryRef: (tag: string) => `localhost:5001/${tag}`,
  pushImageToRegistry: vi.fn(),
}))

import { deleteLeakedBuilderPods } from '#drivers/k8s/images'

beforeEach(() => {
  vi.clearAllMocks()
  mockVapAvailable.mockResolvedValue(true)
  mockKubectlApply.mockResolvedValue(undefined)
  mockKubectlWithRetry.mockResolvedValue({ stdout: '', stderr: '' })
  mockKubectlGetJson.mockResolvedValue(null)
  mockRegistryHasTag.mockResolvedValue(true)
  mockImageExists.mockResolvedValue(false)
})

describe('deleteLeakedBuilderPods', () => {
  it('deletes every builder pod of this install, without waiting', async () => {
    await deleteLeakedBuilderPods()
    expect(mockKubectlWithRetry).toHaveBeenCalledWith([
      'delete', 'pods', '-n', 'test-ns',
      '-l', 'yaac.role=builder,yaac.data-dir-hash=ddh0000000000000',
      '--ignore-not-found', '--wait=false',
    ])
  })
})
