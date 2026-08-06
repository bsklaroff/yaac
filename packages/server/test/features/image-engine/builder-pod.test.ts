/**
 * The builder-pod entry points that are not reached through a chain build:
 * the builder pods' egress policy (applied by the cluster feature before it
 * leases one) and the leaked-pod reaper (a reconcile step).
 *
 * Everything else in this module — pod manifests, in-pod scripts, build
 * argv, context tar, the upstream-image fallback that makes a builder
 * bootstrappable — is exercised through `ensureImage` in
 * build-coordinator.test.ts, where it is actually wired up.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type * as kubectlModule from '#platform/k8s/kubectl'
import type * as registryModule from '#platform/container/registry'
import type * as runtimeModule from '#platform/container/runtime'

vi.mock('#log', () => ({ serverLog: vi.fn(), pipeToServerLog: vi.fn() }))

const mockKubectlApply = vi.hoisted(() => vi.fn())
const mockKubectlWithRetry = vi.hoisted(() => vi.fn())
const mockKubectlGetJson = vi.hoisted(() => vi.fn())
vi.mock('#platform/k8s/kubectl', async (importOriginal) => ({
  ...(await importOriginal<typeof kubectlModule>()),
  k8sNamespace: () => 'test-ns',
  dataDirHash: () => 'ddh0000000000000',
  kubectlApply: mockKubectlApply,
  kubectlWithRetry: mockKubectlWithRetry,
  kubectlGetJson: mockKubectlGetJson,
  ensureKubernetes: vi.fn(),
}))

vi.mock('#features/cluster/cluster-cidrs', () => ({
  nodeIpBlocks: vi.fn().mockResolvedValue(['10.89.0.7/32']),
  apiserverIpBlocks: vi.fn().mockResolvedValue(['10.89.0.7/32']),
  resetClusterCidrCache: vi.fn(),
}))

// Only vapAvailable is consumed from the (heavy) vcluster module.
const mockVapAvailable = vi.hoisted(() => vi.fn())
vi.mock('#features/cluster/vcluster', () => ({ vapAvailable: mockVapAvailable }))

const mockImageExists = vi.hoisted(() => vi.fn())
vi.mock('#platform/container/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof runtimeModule>()),
  imageExists: mockImageExists,
}))

const mockRegistryHasTag = vi.hoisted(() => vi.fn())
vi.mock('#platform/container/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof registryModule>()),
  registryHasTag: mockRegistryHasTag,
  registryRef: (tag: string) => `localhost:5001/${tag}`,
  pushImageToRegistry: vi.fn(),
}))

import {
  buildBuilderEgressNetworkPolicyManifest,
  reconcileBuilderPodGc,
} from '#features/image-engine'
// Reap policy constant, the upstream pin, and the sweep-throttle reset:
// setup values, not units under test.
import {
  BUILDER_REAP_AGE_MS,
  BUILDER_UPSTREAM_IMAGE,
  _resetBuilderReapForTests,
} from '#features/image-engine/builder-pod'


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

describe('buildBuilderEgressNetworkPolicyManifest', () => {
  it('opens egress for builder-labeled pods only', () => {
    const np = buildBuilderEgressNetworkPolicyManifest() as {
      metadata: { namespace: string }
      spec: {
        podSelector: { matchLabels: Record<string, string> }
        policyTypes: string[]
        egress: unknown[]
      }
    }
    expect(np.metadata.namespace).toBe('test-ns')
    expect(np.spec.podSelector.matchLabels).toEqual({ 'yaac.role': 'builder' })
    expect(np.spec.policyTypes).toEqual(['Egress'])
    // Allow-all: a builder pulls upstream bases and pushes products.
    expect(np.spec.egress).toEqual([{}])
  })

  it('rides on a digest-pinned upstream image (the digest IS the pin)', () => {
    // Not a manifest assertion but the same bootstrap fact: nothing yaac
    // builds is needed to stand a builder up.
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
