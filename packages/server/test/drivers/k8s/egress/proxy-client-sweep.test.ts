import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The bootstrap's cluster work is the barrel's; each verb is faked so the
// sequence inside `ensureRunning` — and the one decision it makes about
// the legacy secrets file — runs for real.
const mockSweep = vi.hoisted(() => vi.fn())
const mockEnsureResources = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/cluster', () => ({
  ensureCaConfigMap: vi.fn().mockResolvedValue(undefined),
  ensureNamespace: vi.fn().mockResolvedValue(undefined),
  ensureProxyAuthSecret: vi.fn().mockResolvedValue('s3cret'),
  ensureProxyImage: vi.fn().mockResolvedValue('localhost:5000/yaac-proxy:abc'),
  ensureProxyResources: mockEnsureResources,
  resetProxyClusterIpCache: vi.fn(),
  resolveProxyImageTag: vi.fn().mockResolvedValue('yaac-proxy:abc'),
  sweepLegacyProxySecretsFile: mockSweep,
}))
vi.mock('#drivers/k8s/substrate/kubectl', async (importOriginal) => ({
  ...(await importOriginal<typeof kubectlModule>()),
  k8sNamespace: () => 'yaac',
  kubectlGetJson: vi.fn().mockResolvedValue(null),
}))
vi.mock('#log', () => ({ serverLog: vi.fn() }))

import type * as kubectlModule from '#drivers/k8s/substrate/kubectl'
import { ProxyClient, configureLegacySecretSweep } from '#drivers/k8s/egress/proxy-client'

const realFetch = globalThis.fetch

beforeEach(() => {
  mockSweep.mockReset().mockResolvedValue(undefined)
  mockEnsureResources.mockReset().mockResolvedValue(undefined)
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('ProxyClient.ensureRunning', () => {
  it('sweeps the old secrets file after the rollout, only once nothing is left to import out of it', async () => {
    // The rollout completing is the proof the old proxy — the last reader
    // of the file — is gone; the other condition is the composition root's.
    configureLegacySecretSweep(() => Promise.resolve(true))
    await new ProxyClient({ image: 'yaac-test-proxy' }).ensureRunning()
    expect(mockEnsureResources).toHaveBeenCalledTimes(1)
    expect(mockSweep).not.toHaveBeenCalled()

    configureLegacySecretSweep(() => Promise.resolve(false))
    await new ProxyClient({ image: 'yaac-test-proxy' }).ensureRunning()
    expect(mockSweep).toHaveBeenCalledTimes(1)
    expect(mockSweep.mock.invocationCallOrder[0])
      .toBeGreaterThan(mockEnsureResources.mock.invocationCallOrder[1])
  })
})
