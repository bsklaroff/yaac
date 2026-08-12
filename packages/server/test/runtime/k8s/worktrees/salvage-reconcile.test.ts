import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PodInfo } from '#runtime/k8s/substrate/pods'
import type * as podsModule from '#runtime/k8s/substrate/pods'

const mockSalvage = vi.hoisted(() => vi.fn())
vi.mock('#runtime/k8s/images/image-promoter', () => ({
  salvageWorktreeImages: mockSalvage,
}))

const mockListPods = vi.hoisted(() => vi.fn())
vi.mock('#runtime/k8s/substrate/pods', async (importOriginal) => ({
  ...(await importOriginal<typeof podsModule>()),
  listWorktreePods: mockListPods,
}))

const mockGetCache = vi.hoisted(() => vi.fn())
vi.mock('#runtime/k8s/substrate/cluster-cache', () => ({
  getActiveClusterCache: mockGetCache,
}))

import {
  reconcileImageSalvage,
  SALVAGE_INTERVAL_MS,
  _resetSalvageReconcileForTests,
} from '#runtime/k8s/worktrees/salvage-reconcile'
import { markWorktreeTerminating, _clearTerminatingForTests } from '#runtime/status/terminating'

function pod(worktreeId: string, over: Partial<PodInfo> = {}): PodInfo {
  return {
    jobName: `yaac-p-${worktreeId}`,
    podName: `yaac-p-${worktreeId}-x1`,
    worktreeId,
    projectSlug: 'p',
    tool: 'claude',
    phase: 'Running',
    running: true,
    terminating: false,
    createdAtMs: 0,
    labels: {},
    ...over,
  }
}

beforeEach(() => {
  mockSalvage.mockReset().mockResolvedValue(true)
  mockListPods.mockReset().mockResolvedValue([])
  mockGetCache.mockReset().mockReturnValue(null)
  _resetSalvageReconcileForTests()
  _clearTerminatingForTests()
})

describe('reconcileImageSalvage', () => {
  it('salvages running sessions, throttled to the interval', async () => {
    mockListPods.mockResolvedValue([pod('s1')])
    await reconcileImageSalvage(1_000)
    expect(mockSalvage).toHaveBeenCalledTimes(1)
    expect(mockSalvage).toHaveBeenCalledWith({
      jobName: 'yaac-p-s1', projectSlug: 'p', worktreeId: 's1',
    })

    // Within the interval: no re-run.
    await reconcileImageSalvage(1_000 + SALVAGE_INTERVAL_MS - 1)
    expect(mockSalvage).toHaveBeenCalledTimes(1)

    // Interval elapsed: runs again.
    await reconcileImageSalvage(1_000 + SALVAGE_INTERVAL_MS)
    expect(mockSalvage).toHaveBeenCalledTimes(2)
  })

  it('skips prewarmed spares, terminating pods, and yaac-marked terminating sessions', async () => {
    markWorktreeTerminating('s-marked')
    mockListPods.mockResolvedValue([
      pod('s-prewarm', { labels: { 'yaac.prewarmed': 'true' } }),
      pod('s-term', { terminating: true }),
      pod('s-marked'),
      pod('s-stopped', { running: false }),
    ])
    await reconcileImageSalvage(1_000)
    expect(mockSalvage).not.toHaveBeenCalled()
  })

  it('prunes throttle state for sessions that went away (no leak, fresh session re-runs)', async () => {
    mockListPods.mockResolvedValue([pod('s1')])
    await reconcileImageSalvage(1_000)
    // Session gone → its stamp is pruned...
    mockListPods.mockResolvedValue([])
    await reconcileImageSalvage(2_000)
    // ...so a same-id successor salvages immediately, not after the
    // stale stamp's interval.
    mockListPods.mockResolvedValue([pod('s1')])
    await reconcileImageSalvage(3_000)
    expect(mockSalvage).toHaveBeenCalledTimes(2)
  })

  it('prefers the pod watcher cache and survives a pod-list failure', async () => {
    const worktreePods = vi.fn().mockReturnValue([pod('s-watched')])
    mockGetCache.mockReturnValue({ worktreePods })
    await reconcileImageSalvage(1_000)
    expect(worktreePods).toHaveBeenCalled()
    expect(mockListPods).not.toHaveBeenCalled()
    expect(mockSalvage).toHaveBeenCalledTimes(1)

    mockGetCache.mockReturnValue(null)
    mockListPods.mockRejectedValue(new Error('cluster down'))
    await expect(reconcileImageSalvage(2_000)).resolves.toBeUndefined()
  })
})
