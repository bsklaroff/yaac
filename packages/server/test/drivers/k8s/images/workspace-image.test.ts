import { describe, it, expect, vi, beforeEach } from 'vitest'

const CLUSTER_HOST = 'yaac-registry.yaac.svc.cluster.local:5000'

// The build engine is the process boundary: podman builds and a registry
// push. What this module owns is which of them run, in which order, and
// what the caller is told while they do.
const mockEnsureImage = vi.hoisted(() => vi.fn())
const mockPushImageShared = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/images/build-coordinator', () => ({
  ensureImage: mockEnsureImage,
  pushImageShared: mockPushImageShared,
}))
// The registry is the other side of that boundary: the digest a pod runs
// is what it reports for the tag that was just pushed.
const mockRegistryDigestRef = vi.hoisted(() => vi.fn<(tag: string) => Promise<string>>())
vi.mock('#drivers/k8s/container', () => ({
  registryDigestRef: mockRegistryDigestRef,
}))

import { prepareWorkspaceImage } from '#drivers/k8s/images/workspace-image'

const DIGEST_REF = `${CLUSTER_HOST}/yaac-demo@sha256:051010101af7bd4a`

beforeEach(() => {
  vi.clearAllMocks()
  mockEnsureImage.mockResolvedValue('yaac-demo:abc123')
  mockPushImageShared.mockResolvedValue(`${CLUSTER_HOST}/yaac-demo:abc123`)
  mockRegistryDigestRef.mockResolvedValue(DIGEST_REF)
})

describe('prepareWorkspaceImage', () => {
  // Not the local tag the build produced (the node cannot resolve it), and
  // not the pushed TAG either: `yaac project rebuild` republishes new bytes
  // under an unchanged content-hash tag, and a node that already holds that
  // tag never re-pulls it — so a worktree created after a rebuild would run
  // the pre-rebuild image. The digest is what makes IfNotPresent exact.
  it('answers with the pushed image PINNED to its digest', async () => {
    const ref = await prepareWorkspaceImage({ projectSlug: 'demo', nestedContainers: false })

    expect(ref).toBe(DIGEST_REF)
    expect(mockPushImageShared).toHaveBeenCalledWith(
      'yaac-demo:abc123',
      { projectSlug: 'demo', reason: 'session' },
    )
    // Pinned to what the registry holds AFTER the push, so a rebuild's
    // bytes are the ones named.
    expect(mockRegistryDigestRef).toHaveBeenCalledExactlyOnceWith('yaac-demo:abc123')
    expect(mockEnsureImage.mock.invocationCallOrder[0])
      .toBeLessThan(mockPushImageShared.mock.invocationCallOrder[0])
    expect(mockPushImageShared.mock.invocationCallOrder[0])
      .toBeLessThan(mockRegistryDigestRef.mock.invocationCallOrder[0])
  })

  // A launch that cannot name the bytes it will run must fail here, not
  // fall back to the tag — the fallback is the staleness being fixed.
  it('fails the launch when the pushed image cannot be pinned', async () => {
    mockRegistryDigestRef.mockRejectedValue(new Error('registry unreachable'))

    await expect(prepareWorkspaceImage({ projectSlug: 'demo', nestedContainers: false }))
      .rejects.toThrow(/registry unreachable/)
  })

  it('builds the nestable chain when the workspace runs its own engine', async () => {
    await prepareWorkspaceImage({ projectSlug: 'demo', nestedContainers: true })

    expect(mockEnsureImage).toHaveBeenCalledWith(
      'demo', undefined, false, true, expect.objectContaining({ reason: 'session' }),
    )
  })

  it('narrates the build to the caller, layer by layer', async () => {
    // A build is the longest step a create has, and the layer messages come
    // from deep inside it — the caller owns the narration either way.
    mockEnsureImage.mockImplementation((
      _slug: string, _prefix: unknown, _prebuilt: unknown, _nested: unknown,
      opts: { onLayerStart: (i: number, total: number, layer: string) => void },
    ) => {
      opts.onLayerStart(1, 2, 'base')
      return Promise.resolve('yaac-demo:abc123')
    })
    const messages: string[] = []

    await prepareWorkspaceImage({
      projectSlug: 'demo',
      nestedContainers: false,
      onProgress: (m) => messages.push(m),
    })

    expect(messages).toEqual([
      'Ensuring container images are built...',
      'Building image layer 1/2 (base)...',
      'Pushing session image to the local registry...',
    ])
  })
})
