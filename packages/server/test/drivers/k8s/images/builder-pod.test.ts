/**
 * The builder-pod entry points that are not reached through a chain build:
 * the pinned-image mirror (also called by the e2e global setup), the
 * cluster-wide role guard (applied at `yaac cluster setup`) and the
 * leaked-pod reaper (a reconcile step).
 *
 * Everything else in this module — pod manifests, in-pod scripts, build
 * argv, context tar — is exercised through `ensureImage` in
 * build-coordinator.test.ts, where it is actually wired up.
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
  apiserverIpBlocks: vi.fn().mockResolvedValue(['10.89.0.7/32']),
  resetClusterCidrCache: vi.fn(),
}))

// Only vapAvailable is consumed from the (heavy) vcluster module.
const mockVapAvailable = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/cluster/vcluster', () => ({ vapAvailable: mockVapAvailable }))

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

import { ensureBuilderImage, reconcileBuilderPodGc } from '#drivers/k8s/images'
// Reap policy constant, the upstream pin, and the sweep-throttle reset:
// setup values, not units under test.
import {
  BUILDER_LOCAL_TAG,
  BUILDER_REAP_AGE_MS,
  BUILDER_UPSTREAM_IMAGE,
  _resetBuilderReapForTests,
} from '#drivers/k8s/images/builder-pod'


const reaped = (): string[] =>
  mockKubectlWithRetry.mock.calls
    .map((c) => c[0] as string[])
    .filter((args) => args[0] === 'delete')
    .map((args) => args[2])

beforeEach(() => {
  vi.clearAllMocks()
  _resetBuilderReapForTests()
  mockVapAvailable.mockResolvedValue(true)
  mockKubectlApply.mockResolvedValue(undefined)
  mockKubectlWithRetry.mockResolvedValue({ stdout: '', stderr: '' })
  mockKubectlGetJson.mockResolvedValue(null)
  mockRegistryHasTag.mockResolvedValue(true)
  mockImageExists.mockResolvedValue(false)
})

describe('ensureBuilderImage', () => {
  it('returns the registry ref without pulling when the tag is mirrored', async () => {
    await expect(ensureBuilderImage(true)).resolves.toBe(`localhost:5001/${BUILDER_LOCAL_TAG}`)
  })

  it('refuses to build under requirePrebuilt when the mirror is missing', async () => {
    mockRegistryHasTag.mockResolvedValue(false)
    await expect(ensureBuilderImage(true)).rejects.toThrow(/Restart the test run/)
  })

  it('is digest-pinned upstream (the digest IS the pin — no content hash)', () => {
    expect(BUILDER_UPSTREAM_IMAGE).toMatch(/^quay\.io\/podman\/stable@sha256:[0-9a-f]{64}$/)
  })
})

describe('reconcileBuilderPodGc', () => {
  const NOW = 1_800_000_000_000
  /** This server process started 10 minutes ago. */
  const STARTED = NOW - 600_000

  function podItem(name: string, phase: string, ageMs: number): unknown {
    return {
      metadata: { name, creationTimestamp: new Date(NOW - ageMs).toISOString() },
      status: { phase },
    }
  }

  it('reaps terminal pods and over-age runners, keeps live builds', async () => {
    mockKubectlGetJson.mockResolvedValue({
      items: [
        podItem('yaac-builder-dead-0001', 'Failed', 60_000),
        podItem('yaac-builder-done-0002', 'Succeeded', 60_000),
        podItem('yaac-builder-leak-0003', 'Running', BUILDER_REAP_AGE_MS + 60_000),
        podItem('yaac-builder-live-0004', 'Running', 60_000),
      ],
    })
    await reconcileBuilderPodGc(NOW, STARTED)
    expect(reaped()).toEqual([
      'yaac-builder-dead-0001',
      'yaac-builder-done-0002',
      'yaac-builder-leak-0003',
    ])
  })

  it('reaps a young pod that predates this server process', async () => {
    // A restart orphans the in-flight build's pod. Waiting for the age gate
    // parks its 8 GiB reservation on the node, and the next build cannot
    // schedule until the dead pod's active deadline fires.
    mockKubectlGetJson.mockResolvedValue({
      items: [
        podItem('yaac-builder-orph-0001', 'Running', 700_000),
        podItem('yaac-builder-live-0002', 'Running', 60_000),
      ],
    })
    await reconcileBuilderPodGc(NOW, STARTED)
    expect(reaped()).toEqual(['yaac-builder-orph-0001'])
  })

  it('scopes the sweep to this install\'s builder pods', async () => {
    mockKubectlGetJson.mockResolvedValue({ items: [] })
    await reconcileBuilderPodGc(NOW, STARTED)
    const args = mockKubectlGetJson.mock.calls[0][0] as string[]
    expect(args).toContain('-l')
    expect(args[args.indexOf('-l') + 1])
      .toBe('yaac.role=builder,yaac.data-dir-hash=ddh0000000000000')
  })

  it('is throttled between sweeps', async () => {
    mockKubectlGetJson.mockResolvedValue({ items: [] })
    await reconcileBuilderPodGc(NOW, STARTED)
    await reconcileBuilderPodGc(NOW + 1000, STARTED)
    expect(mockKubectlGetJson).toHaveBeenCalledTimes(1)
  })

  it('survives an unreachable cluster', async () => {
    mockKubectlGetJson.mockRejectedValue(new Error('down'))
    await expect(reconcileBuilderPodGc(NOW, STARTED)).resolves.toBeUndefined()
  })
})
