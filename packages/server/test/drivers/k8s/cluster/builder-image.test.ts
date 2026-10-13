/**
 * The builder pods' image outside of install: a lookup in the local
 * registry, and an actionable error when it is missing. Mirroring it happens
 * at install time and is covered through `buildBuiltinImages`.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { fakeRegistry } from '#test/support/fake-registry'
import { ensureBuilderImage, registryRef } from '#drivers/k8s/cluster'
import { BUILDER_LOCAL_TAG, BUILDER_UPSTREAM_IMAGE } from '#drivers/k8s/cluster/builder-image'

beforeEach(() => {
  fakeRegistry.install()
})

describe('ensureBuilderImage', () => {
  it('answers with the registry ref when the tag is mirrored', async () => {
    fakeRegistry.tags.add(BUILDER_LOCAL_TAG)
    await expect(ensureBuilderImage()).resolves.toBe(registryRef(BUILDER_LOCAL_TAG))
  })

  it('refuses with the command that produces it when the mirror is missing', async () => {
    await expect(ensureBuilderImage()).rejects.toThrow(/builder image podman-stable:v5\.5 is missing.*yaac cluster install/)
  })

  it('refuses the same way when the registry cannot be reached', async () => {
    fakeRegistry.tags.add(BUILDER_LOCAL_TAG)
    fakeRegistry.down = true
    await expect(ensureBuilderImage()).rejects.toThrow(/yaac cluster install/)
  })

  it('is a digest pin, not a content hash — the digest IS the version', () => {
    expect(BUILDER_UPSTREAM_IMAGE).toMatch(/^quay\.io\/podman\/stable@sha256:[0-9a-f]{64}$/)
  })
})
