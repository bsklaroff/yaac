/**
 * The egress proxy's image, as everything but the install sees it: a
 * content-hash tag derived from the k8s/proxy build context, looked up in
 * the local registry, and an actionable refusal when it is not there. The
 * build half is install-time and is covered through `buildBuiltinImages`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type * as registryModule from '#drivers/k8s/container/registry'
import type * as imageEngineModule from '#drivers/k8s/image-engine'

vi.mock('#log', () => ({ serverLog: vi.fn(), pipeToServerLog: vi.fn() }))

const mockContextHash = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/image-engine', async (importOriginal) => ({
  ...(await importOriginal<typeof imageEngineModule>()),
  contextHash: mockContextHash,
}))

const mockRegistryHasTag = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/container/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof registryModule>()),
  registryHasTag: mockRegistryHasTag,
  registryRef: (tag: string) => `localhost:5001/${tag}`,
  pushImageToRegistry: vi.fn(),
}))

import { ensureProxyImage, resolveProxyImageTag } from '#drivers/k8s/cluster'

beforeEach(() => {
  vi.clearAllMocks()
  mockContextHash.mockResolvedValue('abc123def4567890')
})

describe('resolveProxyImageTag', () => {
  it('tags by the content of the proxy build context, without building anything', async () => {
    await expect(resolveProxyImageTag('yaac-proxy')).resolves.toBe('yaac-proxy:abc123def4567890')
    // A pure derivation: the deployed proxy's fingerprint is compared
    // against this, so it must not depend on the registry answering.
    expect(mockRegistryHasTag).not.toHaveBeenCalled()

    // Editing k8s/proxy re-tags it — which is what makes a stale deployment
    // detectable at all.
    mockContextHash.mockResolvedValue('0000111122223333')
    await expect(resolveProxyImageTag('yaac-proxy')).resolves.toBe('yaac-proxy:0000111122223333')
  })

  it('honors the image-name override the e2e suite pins', async () => {
    await expect(resolveProxyImageTag('yaac-test-proxy'))
      .resolves.toBe('yaac-test-proxy:abc123def4567890')
  })
})

describe('ensureProxyImage', () => {
  it('answers with the in-cluster ref when the registry holds the tag', async () => {
    mockRegistryHasTag.mockResolvedValue(true)
    await expect(ensureProxyImage('yaac-proxy'))
      .resolves.toBe('localhost:5001/yaac-proxy:abc123def4567890')
  })

  it('refuses with the command that produces it when the tag is missing', async () => {
    // Lookup-only: the proxy image is yaac-shipped, so a missing tag is a
    // missing install rather than a reason for the server to start building.
    mockRegistryHasTag.mockResolvedValue(false)
    await expect(ensureProxyImage('yaac-proxy'))
      .rejects.toThrow(/Proxy image yaac-proxy:abc123def4567890 is missing.*yaac cluster install/s)
  })
})
