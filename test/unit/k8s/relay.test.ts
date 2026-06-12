import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/container/image-builder', () => ({
  contextHash: vi.fn(),
  ensureImageByTag: vi.fn(),
}))
vi.mock('@/lib/container/runtime', () => ({
  imageExists: vi.fn(),
}))
vi.mock('@/lib/k8s/registry', () => ({
  registryHasTag: vi.fn(),
  registryRef: vi.fn(),
  pushImageToRegistry: vi.fn(),
}))

import { ensureRelayImage, resolveRelayImageTag } from '@/lib/k8s/relay'
import { contextHash, ensureImageByTag } from '@/lib/container/image-builder'
import { imageExists } from '@/lib/container/runtime'
import { pushImageToRegistry, registryHasTag, registryRef } from '@/lib/k8s/registry'
import { RELAY_DIR } from '@/lib/project/paths'

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(contextHash).mockResolvedValue('cafebabe12345678')
  vi.mocked(ensureImageByTag).mockResolvedValue(undefined)
  vi.mocked(imageExists).mockResolvedValue(false)
  vi.mocked(registryHasTag).mockResolvedValue(false)
  vi.mocked(registryRef).mockImplementation((tag: string) => `localhost:5000/${tag}`)
  vi.mocked(pushImageToRegistry)
    .mockImplementation((tag: string) => Promise.resolve(`localhost:5000/${tag}`))
  delete process.env.YAAC_RELAY_IMAGE
})

describe('resolveRelayImageTag', () => {
  it('composes the image name with the build-context content hash', async () => {
    await expect(resolveRelayImageTag()).resolves.toBe('yaac-relay:cafebabe12345678')
  })

  it('honors the YAAC_RELAY_IMAGE test hook', async () => {
    process.env.YAAC_RELAY_IMAGE = 'yaac-test-relay'
    await expect(resolveRelayImageTag()).resolves.toBe('yaac-test-relay:cafebabe12345678')
  })
})

describe('ensureRelayImage', () => {
  it('short-circuits to the registry ref when the tag is already pushed', async () => {
    vi.mocked(registryHasTag).mockResolvedValue(true)
    await expect(ensureRelayImage(false)).resolves.toBe('localhost:5000/yaac-relay:cafebabe12345678')
    expect(ensureImageByTag).not.toHaveBeenCalled()
    expect(pushImageToRegistry).not.toHaveBeenCalled()
  })

  it('builds from k8s/relay and pushes when the image is missing', async () => {
    await expect(ensureRelayImage(false)).resolves.toBe('localhost:5000/yaac-relay:cafebabe12345678')
    expect(ensureImageByTag).toHaveBeenCalledWith(
      'yaac-relay:cafebabe12345678',
      expect.stringContaining(RELAY_DIR),
      RELAY_DIR,
    )
    expect(pushImageToRegistry).toHaveBeenCalledWith('yaac-relay:cafebabe12345678')
  })

  it('fails fast under requirePrebuilt instead of racing a build', async () => {
    await expect(ensureRelayImage(true)).rejects.toThrow(/missing or stale/)
    expect(ensureImageByTag).not.toHaveBeenCalled()
  })
})
