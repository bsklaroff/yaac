import { describe, it, expect, vi, beforeEach } from 'vitest'

// The build engine is the process boundary: podman builds and a registry
// push. What this module owns is which of them run, in which order, and
// what the caller is told while they do.
const mockEnsureImage = vi.hoisted(() => vi.fn())
const mockPushImageShared = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/images/build-coordinator', () => ({
  ensureImage: mockEnsureImage,
  pushImageShared: mockPushImageShared,
}))

import { prepareWorkspaceImage } from '#drivers/k8s/images/workspace-image'

const DEMO = { slug: 'demo', id: '3f2c9a1e-5b7d-4c8e-9f01-2a3b4c5d6e7f' }

beforeEach(() => {
  vi.clearAllMocks()
  mockEnsureImage.mockResolvedValue('yaac-demo:abc123')
  mockPushImageShared.mockResolvedValue('localhost:5000/yaac-demo:abc123')
})

describe('prepareWorkspaceImage', () => {
  it('answers with the PUSHED ref, not the local one the build produced', async () => {
    // The cluster pulls through the registry, so the local tag would name
    // an image the node cannot resolve.
    const ref = await prepareWorkspaceImage({ project: DEMO, nestedContainers: false })

    expect(ref).toBe('localhost:5000/yaac-demo:abc123')
    expect(mockPushImageShared).toHaveBeenCalledWith(
      'yaac-demo:abc123',
      { project: DEMO, reason: 'session' },
    )
    expect(mockEnsureImage.mock.invocationCallOrder[0])
      .toBeLessThan(mockPushImageShared.mock.invocationCallOrder[0])
  })

  it('builds the nestable chain when the workspace runs its own engine', async () => {
    await prepareWorkspaceImage({ project: DEMO, nestedContainers: true })

    expect(mockEnsureImage).toHaveBeenCalledWith(
      DEMO, undefined, false, true, expect.objectContaining({ reason: 'session' }),
    )
  })

  it('narrates the build to the caller, layer by layer', async () => {
    // A build is the longest step a create has, and the layer messages come
    // from deep inside it — the caller owns the narration either way.
    mockEnsureImage.mockImplementation((
      _project: unknown, _prefix: unknown, _prebuilt: unknown, _nested: unknown,
      opts: { onLayerStart: (i: number, total: number, layer: string) => void },
    ) => {
      opts.onLayerStart(1, 2, 'base')
      return Promise.resolve('yaac-demo:abc123')
    })
    const messages: string[] = []

    await prepareWorkspaceImage({
      project: DEMO,
      nestedContainers: false,
      onProgress: (m) => messages.push(m),
    })

    expect(messages).toEqual([
      'Ensuring container images are built...',
      'Building image layer 1/2 (base)...',
      'Publishing the session image to the local registry...',
    ])
  })
})
