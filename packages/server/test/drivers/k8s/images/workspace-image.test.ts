import { describe, it, expect, vi, beforeEach } from 'vitest'

// The build coordinator is faked. This module decides which steps run, in
// what order, and what progress the caller sees.
const mockEnsureImage = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/images/build-coordinator', () => ({
  ensureImage: mockEnsureImage,
}))

import { prepareWorkspaceImage } from '#drivers/k8s/images/workspace-image'

const DEMO = '3f2c9a1e-5b7d-4c8e-9f01-2a3b4c5d6e7f'
const OWNER = 'a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d'

beforeEach(() => {
  vi.clearAllMocks()
  mockEnsureImage.mockResolvedValue('yaac-demo:abc123')
})

describe('prepareWorkspaceImage', () => {
  it('answers with the registry ref, not the bare tag the build produced', async () => {
    // Nodes pull from the registry and cannot resolve a bare tag.
    const ref = await prepareWorkspaceImage({ projectId: DEMO, owner: OWNER, nestedContainers: false })

    expect(ref).toBe('yaac-registry.yaac.svc.cluster.local:5000/yaac-demo:abc123')
  })

  it("builds the owner's nestable chain when the workspace runs its own engine", async () => {
    await prepareWorkspaceImage({ projectId: DEMO, owner: OWNER, nestedContainers: true })

    expect(mockEnsureImage).toHaveBeenCalledWith(
      DEMO, OWNER, undefined, false, true, expect.objectContaining({ reason: 'session' }),
    )
  })

  it('narrates the build to the caller, layer by layer', async () => {
    mockEnsureImage.mockImplementation((
      _project: unknown, _owner: unknown, _prefix: unknown, _prebuilt: unknown, _nested: unknown,
      opts: { onLayerStart: (i: number, total: number, layer: string) => void },
    ) => {
      opts.onLayerStart(1, 2, 'base')
      return Promise.resolve('yaac-demo:abc123')
    })
    const messages: string[] = []

    await prepareWorkspaceImage({
      projectId: DEMO,
      owner: OWNER,
      nestedContainers: false,
      onProgress: (m) => messages.push(m),
    })

    expect(messages).toEqual([
      'Ensuring container images are built...',
      'Building image layer 1/2 (base)...',
    ])
  })
})
