import { describe, it, expect, vi, beforeEach } from 'vitest'

// `drainPendingSpawns` composes the module's own singleton, so the singleton
// is what a test drives. Only its two methods are replaced — everything else
// in the module (and every other importer of it) is untouched.
const mockAttach = vi.hoisted(() => vi.fn())
const mockFetchPending = vi.hoisted(() => vi.fn())

import { drainPendingSpawns, proxyClient } from '#drivers/k8s/egress/proxy-client'
import type { PendingSpawn } from '@yaac/shared/types'

const PENDING: PendingSpawn[] = [
  { requestId: 'r1', worktreeId: 'caller', prompt: 'write the report' },
]

beforeEach(() => {
  mockAttach.mockReset().mockResolvedValue(true)
  mockFetchPending.mockReset().mockResolvedValue(PENDING)
  vi.spyOn(proxyClient, 'attachIfRunning').mockImplementation(mockAttach)
  vi.spyOn(proxyClient, 'fetchPendingSpawns').mockImplementation(mockFetchPending)
})

describe('drainPendingSpawns', () => {
  it('hands back everything the proxy is holding', async () => {
    await expect(drainPendingSpawns()).resolves.toEqual(PENDING)
  })

  // The proxy deploys lazily on the first worktree create, so no proxy means
  // no worktrees means nothing queued. Attaching rather than ensuring is what
  // stops a background drain from standing one up on a fresh install.
  it('reports an empty queue rather than bootstrapping an absent proxy', async () => {
    mockAttach.mockResolvedValue(false)
    await expect(drainPendingSpawns()).resolves.toEqual([])
    expect(mockFetchPending).not.toHaveBeenCalled()
  })

  // A drain is a claim: the caller has to know it failed, because a request
  // taken and never answered leaves its worktree waiting for the timeout.
  it('propagates a failed fetch', async () => {
    mockFetchPending.mockRejectedValue(new Error('tunnel down'))
    await expect(drainPendingSpawns()).rejects.toThrow('tunnel down')
  })
})
