import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ProxyClient } from '@yaac/server/lib/container/proxy-client'
import type * as kubectlModule from '@yaac/server/lib/k8s/kubectl'
import type * as imageBuilderModule from '@yaac/server/lib/container/image-builder'
import type * as registryModule from '@yaac/server/lib/k8s/registry'
import type * as serverLogModule from '@yaac/server/log'

const mockKubectlGetJson = vi.hoisted(() => vi.fn())
vi.mock('@yaac/server/lib/k8s/kubectl', async (importOriginal) => ({
  ...(await importOriginal<typeof kubectlModule>()),
  k8sNamespace: () => 'yaac',
  kubectlGetJson: mockKubectlGetJson,
  kubectlWithRetry: vi.fn(),
  kubectlApply: vi.fn(),
}))

const mockContextHash = vi.hoisted(() => vi.fn())
vi.mock('@yaac/server/lib/container/image-builder', async (importOriginal) => ({
  ...(await importOriginal<typeof imageBuilderModule>()),
  contextHash: mockContextHash,
}))

vi.mock('@yaac/server/lib/k8s/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof registryModule>()),
  registryRef: (tag: string) => `localhost:5001/${tag}`,
  registryHasTag: vi.fn(),
  pushImageToRegistry: vi.fn(),
}))

vi.mock('@yaac/server/log', async (importOriginal) => ({
  ...(await importOriginal<typeof serverLogModule>()),
  serverLog: vi.fn(),
  pipeToServerLog: vi.fn(),
}))

function deploymentWithImage(image: string): object {
  return { spec: { template: { spec: { containers: [{ image }] } } } }
}

describe('ProxyClient.isDeployedImageCurrent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockContextHash.mockResolvedValue('abc123')
  })

  it('returns true when the deployed image carries the current content hash', async () => {
    mockKubectlGetJson.mockResolvedValueOnce(
      deploymentWithImage('localhost:5001/yaac-test-proxy:abc123'),
    )
    const c = new ProxyClient({ image: 'yaac-test-proxy' })
    await expect(c.isDeployedImageCurrent()).resolves.toBe(true)
  })

  it('returns false when the deployed image was built from older source', async () => {
    mockKubectlGetJson.mockResolvedValueOnce(
      deploymentWithImage('localhost:5001/yaac-test-proxy:stale00'),
    )
    const c = new ProxyClient({ image: 'yaac-test-proxy' })
    await expect(c.isDeployedImageCurrent()).resolves.toBe(false)
  })

  it('returns false when the Deployment is missing (bootstrap must recreate it)', async () => {
    mockKubectlGetJson.mockResolvedValueOnce(null)
    const c = new ProxyClient({ image: 'yaac-test-proxy' })
    await expect(c.isDeployedImageCurrent()).resolves.toBe(false)
  })

  it('returns true when kubectl fails — a healthy proxy must not be churned on a transient error', async () => {
    mockKubectlGetJson.mockRejectedValueOnce(new Error('connection refused'))
    const c = new ProxyClient({ image: 'yaac-test-proxy' })
    await expect(c.isDeployedImageCurrent()).resolves.toBe(true)
  })
})

describe('ProxyClient.ensureRunning image staleness gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockContextHash.mockResolvedValue('abc123')
  })

  /**
   * A client forced into the attached state (running=true with a live
   * port), the state attachIfRunning() leaves behind, with /healthz
   * answering OK.
   */
  function attachedClient(): ProxyClient {
    const c = new ProxyClient({ image: 'yaac-test-proxy' })
    const internal = c as unknown as {
      running: boolean
      authSecret: string
      forward: { currentPort: number }
    }
    internal.running = true
    internal.authSecret = 'secret'
    internal.forward = { currentPort: 12345 }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    return c
  }

  it('returns on the fast path when the deployed image is current', async () => {
    const c = attachedClient()
    mockKubectlGetJson.mockResolvedValueOnce(
      deploymentWithImage('localhost:5001/yaac-test-proxy:abc123'),
    )
    const bootstrap = vi.spyOn(
      c as unknown as { ensureProxyImage: () => Promise<string> },
      'ensureProxyImage',
    )
    await c.ensureRunning()
    expect(bootstrap).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('falls through to the full bootstrap when the deployed image is stale', async () => {
    const c = attachedClient()
    mockKubectlGetJson.mockResolvedValue(
      deploymentWithImage('localhost:5001/yaac-test-proxy:stale00'),
    )
    const bootstrap = vi
      .spyOn(
        c as unknown as { ensureProxyImage: () => Promise<string> },
        'ensureProxyImage',
      )
      .mockRejectedValueOnce(new Error('bootstrap reached'))
    await expect(c.ensureRunning()).rejects.toThrow('bootstrap reached')
    expect(bootstrap).toHaveBeenCalledOnce()
    vi.unstubAllGlobals()
  })
})
