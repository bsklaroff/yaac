import { afterEach, describe, expect, it, vi } from 'vitest'
import { reconcileProxySshKeys } from '@/lib/session/proxy-reconcile'
import type * as proxyClientModule from '@/lib/container/proxy-client'

const mockAttachIfRunning = vi.hoisted(() => vi.fn())
const mockReconcileSshKeys = vi.hoisted(() => vi.fn())
vi.mock('@/lib/container/proxy-client', async (importOriginal) => ({
  ...(await importOriginal<typeof proxyClientModule>()),
  proxyClient: {
    attachIfRunning: mockAttachIfRunning,
    reconcileSshKeys: mockReconcileSshKeys,
  },
}))

vi.mock('@/daemon/log', () => ({ daemonLog: vi.fn() }))

describe('reconcileProxySshKeys', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('no-ops when the proxy is not deployed (attach-only, never bootstraps)', async () => {
    mockAttachIfRunning.mockResolvedValueOnce(false)
    await reconcileProxySshKeys()
    expect(mockReconcileSshKeys).not.toHaveBeenCalled()
  })

  it('heals ssh-agent keys when attached', async () => {
    mockAttachIfRunning.mockResolvedValueOnce(true)
    await reconcileProxySshKeys()
    expect(mockReconcileSshKeys).toHaveBeenCalledOnce()
  })

  it('survives an ssh-agent key heal failure', async () => {
    mockAttachIfRunning.mockResolvedValueOnce(true)
    mockReconcileSshKeys.mockRejectedValueOnce(new Error('agent down'))
    await expect(reconcileProxySshKeys()).resolves.toBeUndefined()
  })
})
