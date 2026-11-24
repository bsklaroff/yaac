/**
 * The utility image outside of install: the digest install recorded
 * for its mirror, and an actionable error when it is missing. Mirroring it happens
 * at install time and is covered through `buildBuiltinImages`.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { fakeRegistry } from '#test/support/fake-registry'
import { ensureUtilityImage, registryRef } from '#drivers/k8s/cluster'
import { UTILITY_MIRROR_TAG, UTILITY_UPSTREAM_IMAGE } from '#drivers/k8s/cluster/utility-image'

const OTHER_DIGEST = `sha256:${'f'.repeat(64)}`

beforeEach(() => {
  fakeRegistry.install()
})

describe('ensureUtilityImage', () => {
  it('answers with the recorded digest, which a rewritten tag does not move', async () => {
    fakeRegistry.mirror(UTILITY_MIRROR_TAG)
    const pinned = registryRef(`podman-stable@${fakeRegistry.digestOf(UTILITY_MIRROR_TAG)}`)
    await expect(ensureUtilityImage()).resolves.toBe(pinned)
    expect(fakeRegistry.lookups).toEqual([pinned.slice(pinned.indexOf('/') + 1)])

    // Other bytes pushed under the tag; the recorded manifest is untagged
    // but still served until a GC collects it, and then refused.
    fakeRegistry.push(UTILITY_MIRROR_TAG, OTHER_DIGEST)
    await expect(ensureUtilityImage()).resolves.toBe(pinned)
    fakeRegistry.collect()
    await expect(ensureUtilityImage()).rejects.toThrow(/utility image .* is missing.*yaac cluster install/)
  })

  it('refuses with the command that produces it when no digest was recorded', async () => {
    // A tag pushed by anything but install's mirror step is not trusted.
    fakeRegistry.push(UTILITY_MIRROR_TAG)
    await expect(ensureUtilityImage()).rejects.toThrow(/utility image podman-stable:v5\.5-[0-9a-f]{12} is missing.*yaac cluster install/)
  })

  it('treats a malformed record as missing rather than putting it in an image ref', async () => {
    // A registry would answer `@v5.5` as a tag, and fetch normalizes `../`.
    fakeRegistry.holdsAll = true
    for (const value of ['v5.5', `${OTHER_DIGEST}/../../x/manifests/y`, `${OTHER_DIGEST}?x=1`, 'sha256:short', ' ']) {
      fakeRegistry.record(UTILITY_MIRROR_TAG, value)
      await expect(ensureUtilityImage(), value).rejects.toThrow(/yaac cluster install/)
    }
  })

  it('refuses the same way when the registry cannot be reached', async () => {
    fakeRegistry.mirror(UTILITY_MIRROR_TAG)
    fakeRegistry.down = true
    await expect(ensureUtilityImage()).rejects.toThrow(/yaac cluster install/)
  })

  it('is a digest pin, not a content hash — the digest IS the version', () => {
    expect(UTILITY_UPSTREAM_IMAGE).toMatch(/^quay\.io\/podman\/stable@sha256:[0-9a-f]{64}$/)
  })
})
