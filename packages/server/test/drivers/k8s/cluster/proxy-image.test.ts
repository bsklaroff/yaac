/**
 * Resolving the egress proxy's image: a content-hash tag of the k8s/proxy
 * build context, looked up in the local registry. Building it happens at
 * install time and is covered through `buildBuiltinImages`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fakeRegistry } from '#test/support/fake-registry'
import { PROXY_DIR } from '@yaac/shared/project-paths'
import { contextHash, ensureProxyImage, registryRef, resolveProxyImageTag } from '#drivers/k8s/cluster'

/** The k8s/proxy build context's content hash. */
let hash: string

beforeEach(async () => {
  hash = await contextHash(PROXY_DIR)
  fakeRegistry.install()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('resolveProxyImageTag', () => {
  it('tags by the content of the proxy build context, without the registry', async () => {
    // The deployed proxy is compared against this tag, so deriving it must
    // not need the registry.
    fakeRegistry.down = true
    await expect(resolveProxyImageTag('yaac-proxy')).resolves.toBe(`yaac-proxy:${hash}`)
  })

  it('honors the image-name override the e2e suite pins', async () => {
    await expect(resolveProxyImageTag('yaac-test-proxy')).resolves.toBe(`yaac-test-proxy:${hash}`)
  })
})

describe('ensureProxyImage', () => {
  it('answers with the in-cluster ref when the registry holds the tag', async () => {
    fakeRegistry.tags.add(`yaac-proxy:${hash}`)
    await expect(ensureProxyImage('yaac-proxy')).resolves.toBe(registryRef(`yaac-proxy:${hash}`))
  })

  it('refuses with the command that produces it when the tag is missing', async () => {
    // A missing tag means the install is incomplete; the server never
    // builds this image.
    await expect(ensureProxyImage('yaac-proxy'))
      .rejects.toThrow(new RegExp(`Proxy image yaac-proxy:${hash} is missing.*yaac cluster install`, 's'))
  })
})
