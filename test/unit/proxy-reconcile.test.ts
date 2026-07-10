import { afterEach, describe, expect, it, vi } from 'vitest'
import { reconcileProxySshKeys } from '@yaac/server/lib/session/proxy-reconcile'
import type * as proxyClientModule from '@yaac/server/lib/container/proxy-client'

const mockAttachIfRunning = vi.hoisted(() => vi.fn())
const mockReconcileSshKeys = vi.hoisted(() => vi.fn())
vi.mock('@yaac/server/lib/container/proxy-client', async (importOriginal) => ({
  ...(await importOriginal<typeof proxyClientModule>()),
  proxyClient: {
    attachIfRunning: mockAttachIfRunning,
    reconcileSshKeys: mockReconcileSshKeys,
  },
}))

vi.mock('@yaac/server/log', () => ({ serverLog: vi.fn() }))

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
