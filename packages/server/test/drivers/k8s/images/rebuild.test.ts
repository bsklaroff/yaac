import { describe, it, expect, vi, beforeEach } from 'vitest'

// The build coordinator is the process boundary here — podman builds and a
// registry push. What this module owns is that BOTH run, in that order, and
// that the push is forced.
const mockRebuildProjectImage = vi.hoisted(() => vi.fn<
  (slug: string, opts?: { imagePrefix?: string; onLog?: (line: string) => void }) => Promise<string>
>())
const mockPushImageShared = vi.hoisted(() => vi.fn<
  (tag: string, ctx: unknown, opts?: unknown) => Promise<string>
>())
vi.mock('#drivers/k8s/images/build-coordinator', () => ({
  rebuildProjectImage: mockRebuildProjectImage,
  pushImageShared: mockPushImageShared,
}))

import { rebuildAndPushProjectImage } from '#drivers/k8s/images/rebuild'

beforeEach(() => {
  vi.clearAllMocks()
  mockRebuildProjectImage.mockResolvedValue('yaac-user-demo:abc123')
  mockPushImageShared.mockResolvedValue('localhost:5000/yaac-user-demo:abc123')
})

describe('rebuildAndPushProjectImage', () => {
  // THE reason the two halves are one verb: a rebuild changes image bytes
  // under an unchanged content-hash tag, so an unforced push sees the tag
  // already in the registry and publishes nothing — the rebuild reports
  // success and every new worktree keeps running the old bytes.
  it('forces the push, since the tag did not change', async () => {
    await rebuildAndPushProjectImage('demo')

    expect(mockPushImageShared).toHaveBeenCalledExactlyOnceWith(
      'yaac-user-demo:abc123',
      { projectSlug: 'demo', reason: 'rebuild' },
      { force: true },
    )
  })

  it('pushes only after the rebuild finished', async () => {
    const order: string[] = []
    mockRebuildProjectImage.mockImplementation(() => {
      order.push('rebuild')
      return Promise.resolve('yaac-user-demo:abc123')
    })
    mockPushImageShared.mockImplementation(() => {
      order.push('push')
      return Promise.resolve('localhost:5000/yaac-user-demo:abc123')
    })

    await rebuildAndPushProjectImage('demo')

    expect(order).toEqual(['rebuild', 'push'])
  })

  // The caller names the image by the tag the chain resolved, not by the
  // registry ref: it is what the CLI prints and what a later create's own
  // resolution will produce.
  it('answers the rebuilt tag and narrates the push', async () => {
    const lines: string[] = []

    const tag = await rebuildAndPushProjectImage('demo', {
      imagePrefix: 'yaac-test',
      onLog: (line) => lines.push(line),
    })

    expect(tag).toBe('yaac-user-demo:abc123')
    const [slug, opts] = mockRebuildProjectImage.mock.calls[0]
    expect(slug).toBe('demo')
    expect(opts?.imagePrefix).toBe('yaac-test')
    expect(typeof opts?.onLog).toBe('function')
    expect(lines).toEqual(['Pushing rebuilt image to the local registry...'])
  })

  it('publishes nothing when the rebuild failed', async () => {
    mockRebuildProjectImage.mockRejectedValue(new Error('standalone Dockerfile.yaac'))

    await expect(rebuildAndPushProjectImage('demo')).rejects.toThrow(/standalone/)
    expect(mockPushImageShared).not.toHaveBeenCalled()
  })

  // A rebuild that built but could not publish is a FAILURE, not a partial
  // success: the tag names bytes the cluster cannot pull.
  it('surfaces a push that failed', async () => {
    mockPushImageShared.mockRejectedValue(new Error('registry refused'))

    await expect(rebuildAndPushProjectImage('demo')).rejects.toThrow(/registry refused/)
  })
})
