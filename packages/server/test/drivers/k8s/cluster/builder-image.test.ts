/**
 * The builder pods' image outside of install: a lookup in the local
 * registry, and an actionable error when it is missing. Mirroring it happens
 * at install time and is covered through `buildBuiltinImages`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type * as registryModule from '#drivers/k8s/container/registry'
import type * as runtimeModule from '#drivers/k8s/container/runtime'

const mockImageExists = vi.hoisted(() => vi.fn())
const mockExecFileAsync = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/container/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof runtimeModule>()),
  imageExists: mockImageExists,
  execFileAsync: mockExecFileAsync,
}))

const mockRegistryHasTag = vi.hoisted(() => vi.fn())
const mockPush = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/container/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof registryModule>()),
  registryHasTag: mockRegistryHasTag,
  registryRef: (tag: string) => `localhost:5001/${tag}`,
  pushImageToRegistry: mockPush,
}))

import { ensureBuilderImage } from '#drivers/k8s/cluster'
import { BUILDER_LOCAL_TAG, BUILDER_UPSTREAM_IMAGE } from '#drivers/k8s/cluster/builder-image'

beforeEach(() => {
  vi.clearAllMocks()
  mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' })
  mockPush.mockResolvedValue(`localhost:5001/${BUILDER_LOCAL_TAG}`)
})

describe('ensureBuilderImage', () => {
  it('answers with the registry ref when the tag is mirrored', async () => {
    mockRegistryHasTag.mockResolvedValue(true)
    await expect(ensureBuilderImage()).resolves.toBe(`localhost:5001/${BUILDER_LOCAL_TAG}`)
    // No container engine is touched; the calling server may not have one.
    expect(mockExecFileAsync).not.toHaveBeenCalled()
  })

  it('refuses with the command that produces it when the mirror is missing', async () => {
    mockRegistryHasTag.mockResolvedValue(false)
    await expect(ensureBuilderImage()).rejects.toThrow(/yaac cluster install/)
    expect(mockExecFileAsync).not.toHaveBeenCalled()
  })

  it('is a digest pin, not a content hash — the digest IS the version', () => {
    expect(BUILDER_UPSTREAM_IMAGE).toMatch(/^quay\.io\/podman\/stable@sha256:[0-9a-f]{64}$/)
  })
})
