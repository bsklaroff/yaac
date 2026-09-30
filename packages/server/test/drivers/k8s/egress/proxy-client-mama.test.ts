import { describe, it, expect, vi, beforeEach } from 'vitest'

// `drainPendingMamaRequests` uses the module's singleton client, so the
// tests stub two of its methods.
const mockAttach = vi.hoisted(() => vi.fn())
const mockFetchPending = vi.hoisted(() => vi.fn())

import { drainPendingMamaRequests, proxyClient } from '#drivers/k8s/egress/proxy-client'
import type { PendingMamaRequest } from '@yaac/shared/types'

const PENDING: PendingMamaRequest[] = [
  { requestId: 'r1', workspaceId: 'caller', command: 'create', args: {}, body: 'write the report' },
]

beforeEach(() => {
  mockAttach.mockReset().mockResolvedValue(true)
  mockFetchPending.mockReset().mockResolvedValue(PENDING)
  vi.spyOn(proxyClient, 'attachIfRunning').mockImplementation(mockAttach)
  vi.spyOn(proxyClient, 'fetchPendingMamaRequests').mockImplementation(mockFetchPending)
})

describe('drainPendingMamaRequests', () => {
  it('hands back everything the proxy is holding', async () => {
    await expect(drainPendingMamaRequests()).resolves.toEqual(PENDING)
  })

  // The proxy is deployed on the first workspace create, so no proxy means
  // nothing is queued. Attaching (not ensuring) keeps a background drain from
  // deploying one.
  it('reports an empty queue rather than bootstrapping an absent proxy', async () => {
    mockAttach.mockResolvedValue(false)
    await expect(drainPendingMamaRequests()).resolves.toEqual([])
    expect(mockFetchPending).not.toHaveBeenCalled()
  })

  // The caller must know a drain failed, or a claimed request is never
  // answered and its workspace waits for the timeout.
  it('propagates a failed fetch', async () => {
    mockFetchPending.mockRejectedValue(new Error('tunnel down'))
    await expect(drainPendingMamaRequests()).rejects.toThrow('tunnel down')
  })
})
