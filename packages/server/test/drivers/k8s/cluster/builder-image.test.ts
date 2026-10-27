/**
 * The builder pods' image outside of install: the digest install recorded
 * for its mirror, and an actionable error when it is missing. Mirroring it happens
 * at install time and is covered through `buildBuiltinImages`.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { fakeRegistry } from '#test/support/fake-registry'
import { ensureBuilderImage, registryRef } from '#drivers/k8s/cluster'
import { BUILDER_MIRROR_TAG, BUILDER_UPSTREAM_IMAGE } from '#drivers/k8s/cluster/builder-image'

const OTHER_DIGEST = `sha256:${'f'.repeat(64)}`

beforeEach(() => {
  fakeRegistry.install()
})

describe('ensureBuilderImage', () => {
  it('answers with the recorded digest, which a rewritten tag does not move', async () => {
    fakeRegistry.mirror(BUILDER_MIRROR_TAG)
    const pinned = registryRef(`podman-stable@${fakeRegistry.digestOf(BUILDER_MIRROR_TAG)}`)
    await expect(ensureBuilderImage()).resolves.toBe(pinned)
    expect(fakeRegistry.lookups).toEqual([pinned.slice(pinned.indexOf('/') + 1)])

    // Other bytes pushed under the tag; the recorded manifest is untagged
    // but still served until a GC collects it, and then refused.
    fakeRegistry.push(BUILDER_MIRROR_TAG, OTHER_DIGEST)
    await expect(ensureBuilderImage()).resolves.toBe(pinned)
    fakeRegistry.collect()
    await expect(ensureBuilderImage()).rejects.toThrow(/builder image .* is missing.*yaac cluster install/)
  })

  it('refuses with the command that produces it when no digest was recorded', async () => {
    // A tag pushed by anything but install's mirror step is not trusted.
    fakeRegistry.push(BUILDER_MIRROR_TAG)
    await expect(ensureBuilderImage()).rejects.toThrow(/builder image podman-stable:v5\.5-[0-9a-f]{12} is missing.*yaac cluster install/)
  })

  it('treats a malformed record as missing rather than putting it in an image ref', async () => {
    // A registry would answer `@v5.5` as a tag, and fetch normalizes `../`.
    fakeRegistry.holdsAll = true
    for (const value of ['v5.5', `${OTHER_DIGEST}/../../x/manifests/y`, `${OTHER_DIGEST}?x=1`, 'sha256:short', ' ']) {
      fakeRegistry.record(BUILDER_MIRROR_TAG, value)
      await expect(ensureBuilderImage(), value).rejects.toThrow(/yaac cluster install/)
    }
  })

  it('refuses the same way when the registry cannot be reached', async () => {
    fakeRegistry.mirror(BUILDER_MIRROR_TAG)
    fakeRegistry.down = true
    await expect(ensureBuilderImage()).rejects.toThrow(/yaac cluster install/)
  })

  it('is a digest pin, not a content hash — the digest IS the version', () => {
    expect(BUILDER_UPSTREAM_IMAGE).toMatch(/^quay\.io\/podman\/stable@sha256:[0-9a-f]{64}$/)
  })
})
