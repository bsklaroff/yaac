/**
 * The builder image outside of install: its content-hash tag, the digest
 * install recorded for it, and the buildkitd config its daemons start
 * with. Building and pushing it is covered through `buildBuiltinImages`.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { fakeRegistry } from '#test/support/fake-registry'
import { buildkitdConfig, ensureBuilderImage, registryRef, resolveBuilderImageTag } from '#drivers/k8s/cluster'

beforeEach(() => {
  fakeRegistry.install()
})

describe('resolveBuilderImageTag', () => {
  it('tags the image by its build context, under the install or test prefix', async () => {
    const tag = await resolveBuilderImageTag()
    expect(tag).toMatch(/^yaac-buildkit:[0-9a-f]{16}$/)
    expect(await resolveBuilderImageTag('yaac-test')).toBe(tag.replace('yaac-', 'yaac-test-'))
  })
})

describe('ensureBuilderImage', () => {
  it('answers with the digest install recorded, and names install when it has none', async () => {
    const tag = await resolveBuilderImageTag()
    await expect(ensureBuilderImage()).rejects.toThrow(/builder image .* is missing.*yaac cluster install/)
    fakeRegistry.mirror(tag)
    await expect(ensureBuilderImage()).resolves
      .toBe(registryRef(`yaac-buildkit@${fakeRegistry.digestOf(tag)}`))
  })
})

describe('buildkitdConfig', () => {
  it('turns gateway frontends off and names its plain-HTTP registries', () => {
    const pod = buildkitdConfig({ plainHttp: ['r:5002'] })
    expect(pod).toContain('[frontend."gateway.v0"]\n  enabled = false')
    expect(pod).toContain('snapshotter = "overlayfs"')
    expect(pod).toContain('[registry."r:5002"]\n  http = true')
    // No daemon GC: a pod's state dies with it, and install prunes the
    // host daemon's.
    expect(pod).toContain('gc = false')
  })
})
