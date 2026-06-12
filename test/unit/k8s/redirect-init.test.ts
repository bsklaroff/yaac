import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/container/image-builder', () => ({
  contextHash: vi.fn().mockResolvedValue('cafebabe12345678'),
  ensureImageByTag: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/container/runtime', () => ({
  imageExists: vi.fn().mockResolvedValue(false),
}))
vi.mock('@/lib/k8s/registry', () => ({
  registryHasTag: vi.fn().mockResolvedValue(false),
  registryRef: vi.fn((tag: string) => `localhost:5000/${tag}`),
  pushImageToRegistry: vi.fn((tag: string) => Promise.resolve(`localhost:5000/${tag}`)),
}))

import {
  ensureRedirectInitImage,
  resolveRedirectInitImageTag,
} from '@/lib/k8s/redirect-init'
import { contextHash, ensureImageByTag } from '@/lib/container/image-builder'
import { imageExists } from '@/lib/container/runtime'
import { pushImageToRegistry, registryHasTag, registryRef } from '@/lib/k8s/registry'
import { REDIRECT_INIT_DIR } from '@/lib/project/paths'

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(contextHash).mockResolvedValue('cafebabe12345678')
  vi.mocked(ensureImageByTag).mockResolvedValue(undefined)
  vi.mocked(imageExists).mockResolvedValue(false)
  vi.mocked(registryHasTag).mockResolvedValue(false)
  vi.mocked(registryRef).mockImplementation((tag: string) => `localhost:5000/${tag}`)
  vi.mocked(pushImageToRegistry)
    .mockImplementation((tag: string) => Promise.resolve(`localhost:5000/${tag}`))
  delete process.env.YAAC_REDIRECT_INIT_IMAGE
})

describe('resolveRedirectInitImageTag', () => {
  it('composes the image name with the build-context content hash', async () => {
    await expect(resolveRedirectInitImageTag())
      .resolves.toBe('yaac-redirect-init:cafebabe12345678')
  })

  it('honors the YAAC_REDIRECT_INIT_IMAGE test hook', async () => {
    process.env.YAAC_REDIRECT_INIT_IMAGE = 'yaac-test-redirect-init'
    await expect(resolveRedirectInitImageTag())
      .resolves.toBe('yaac-test-redirect-init:cafebabe12345678')
  })
})

describe('ensureRedirectInitImage', () => {
  it('short-circuits to the registry ref when the tag is already pushed', async () => {
    vi.mocked(registryHasTag).mockResolvedValue(true)
    await expect(ensureRedirectInitImage(false))
      .resolves.toBe('localhost:5000/yaac-redirect-init:cafebabe12345678')
    expect(ensureImageByTag).not.toHaveBeenCalled()
    expect(pushImageToRegistry).not.toHaveBeenCalled()
  })

  it('builds from k8s/redirect-init and pushes when the image is missing', async () => {
    await expect(ensureRedirectInitImage(false))
      .resolves.toBe('localhost:5000/yaac-redirect-init:cafebabe12345678')
    expect(ensureImageByTag).toHaveBeenCalledWith(
      'yaac-redirect-init:cafebabe12345678',
      expect.stringContaining(REDIRECT_INIT_DIR),
      REDIRECT_INIT_DIR,
    )
    expect(pushImageToRegistry).toHaveBeenCalledWith('yaac-redirect-init:cafebabe12345678')
  })

  it('skips the build (push only) when the image exists locally', async () => {
    vi.mocked(imageExists).mockResolvedValue(true)
    await ensureRedirectInitImage(false)
    expect(ensureImageByTag).not.toHaveBeenCalled()
    expect(pushImageToRegistry).toHaveBeenCalled()
  })

  it('fails fast under requirePrebuilt instead of racing a build', async () => {
    await expect(ensureRedirectInitImage(true))
      .rejects.toThrow(/missing or stale/)
    expect(ensureImageByTag).not.toHaveBeenCalled()
  })
})
