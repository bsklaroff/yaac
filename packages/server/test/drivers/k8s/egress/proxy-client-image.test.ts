import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ProxyClient } from '#drivers/k8s/egress/proxy-client'
import type * as kubectlModule from '#drivers/k8s/substrate/kubectl'
import type * as imageBuilderModule from '#drivers/k8s/image-engine/image-builder'
import type * as registryModule from '#drivers/k8s/container/registry'
import type * as serverLogModule from '#log'

const mockKubectlGetJson = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/substrate/kubectl', async (importOriginal) => ({
  ...(await importOriginal<typeof kubectlModule>()),
  k8sNamespace: () => 'yaac',
  kubectlGetJson: mockKubectlGetJson,
  kubectlWithRetry: vi.fn(),
  kubectlApply: vi.fn(),
}))

const mockContextHash = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/image-engine/image-builder', async (importOriginal) => ({
  ...(await importOriginal<typeof imageBuilderModule>()),
  contextHash: mockContextHash,
}))

vi.mock('#drivers/k8s/container/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof registryModule>()),
  registryRef: (tag: string) => `localhost:5001/${tag}`,
  registryHasTag: vi.fn(),
  pushImageToRegistry: vi.fn(),
}))

vi.mock('#log', async (importOriginal) => ({
  ...(await importOriginal<typeof serverLogModule>()),
  serverLog: vi.fn(),
  pipeToServerLog: vi.fn(),
}))

function deployedProxy(image: string, runtimeClassName?: string): object {
  return {
    spec: {
      template: {
        spec: {
          ...(runtimeClassName !== undefined ? { runtimeClassName } : {}),
          containers: [{ image }],
        },
      },
    },
  }
}

describe('ProxyClient.isDeployedProxyCurrent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockContextHash.mockResolvedValue('abc123')
  })

  it('returns true when the image matches and no RuntimeClass is stamped', async () => {
    mockKubectlGetJson.mockResolvedValueOnce(
      deployedProxy('localhost:5001/yaac-test-proxy:abc123'),
    )
    const c = new ProxyClient({ image: 'yaac-test-proxy' })
    await expect(c.isDeployedProxyCurrent()).resolves.toBe(true)
  })

  it('returns false when the deployed image was built from older source', async () => {
    mockKubectlGetJson.mockResolvedValueOnce(
      deployedProxy('localhost:5001/yaac-test-proxy:stale00'),
    )
    const c = new ProxyClient({ image: 'yaac-test-proxy' })
    await expect(c.isDeployedProxyCurrent()).resolves.toBe(false)
  })

  it('returns false when the pod template still carries a RuntimeClass (manifest-only upgrade)', async () => {
    // Same image, but infra runs on runc, so a gvisor RuntimeClass means
    // the Deployment is stale. An image-only check would miss it.
    mockKubectlGetJson.mockResolvedValueOnce(
      deployedProxy('localhost:5001/yaac-test-proxy:abc123', 'gvisor'),
    )
    const c = new ProxyClient({ image: 'yaac-test-proxy' })
    await expect(c.isDeployedProxyCurrent()).resolves.toBe(false)
  })

  it('returns false when the Deployment is missing (bootstrap must recreate it)', async () => {
    mockKubectlGetJson.mockResolvedValueOnce(null)
    const c = new ProxyClient({ image: 'yaac-test-proxy' })
    await expect(c.isDeployedProxyCurrent()).resolves.toBe(false)
  })

  it('returns true when kubectl fails — a healthy proxy must not be churned on a transient error', async () => {
    mockKubectlGetJson.mockRejectedValueOnce(new Error('connection refused'))
    const c = new ProxyClient({ image: 'yaac-test-proxy' })
    await expect(c.isDeployedProxyCurrent()).resolves.toBe(true)
  })
})

describe('ProxyClient.ensureRunning staleness gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockContextHash.mockResolvedValue('abc123')
  })

  /**
   * A client that has seen the proxy running but not yet checked its
   * version, with /healthz answering OK.
   */
  function attachedClient(): ProxyClient {
    const c = new ProxyClient({ image: 'yaac-test-proxy' })
    ;(c as unknown as { running: boolean }).running = true
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    return c
  }

  it('returns on the fast path when the deployed proxy is current', async () => {
    const c = attachedClient()
    mockKubectlGetJson.mockResolvedValueOnce(
      deployedProxy('localhost:5001/yaac-test-proxy:abc123'),
    )
    const bootstrap = vi.spyOn(
      c as unknown as { ensureProxyImage: () => Promise<string> },
      'ensureProxyImage',
    )
    await c.ensureRunning()
    expect(bootstrap).not.toHaveBeenCalled()
    // A plain Service dial: the server runs in the proxy's namespace
    // (docs/server-in-cluster.md).
    expect(vi.mocked(fetch).mock.calls[0][0])
      .toMatch(/^http:\/\/yaac-proxy\.[^/]+\.svc\.cluster\.local:10255\/healthz$/)
    vi.unstubAllGlobals()
  })

  it('falls through to the full bootstrap when the deployed image is stale', async () => {
    const c = attachedClient()
    mockKubectlGetJson.mockResolvedValue(
      deployedProxy('localhost:5001/yaac-test-proxy:stale00'),
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

  it('falls through to the full bootstrap when only the RuntimeClass is stale', async () => {
    const c = attachedClient()
    mockKubectlGetJson.mockResolvedValue(
      deployedProxy('localhost:5001/yaac-test-proxy:abc123', 'gvisor'),
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

describe('ProxyClient.rollIfStale', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockContextHash.mockResolvedValue('abc123')
  })

  async function rolled(deployment: object | null): Promise<boolean> {
    const c = new ProxyClient({ image: 'yaac-test-proxy' })
    const ensure = vi.spyOn(c, 'ensureRunning').mockResolvedValue()
    mockKubectlGetJson.mockResolvedValue(deployment)
    await c.rollIfStale()
    return ensure.mock.calls.length > 0
  }

  it('redeploys only a proxy that exists and is from another build', async () => {
    await expect(rolled(deployedProxy('localhost:5001/yaac-test-proxy:stale00'))).resolves.toBe(true)
    await expect(rolled(deployedProxy('localhost:5001/yaac-test-proxy:abc123'))).resolves.toBe(false)
    // No proxy yet: the first launch deploys it.
    await expect(rolled(null)).resolves.toBe(false)
  })
})
