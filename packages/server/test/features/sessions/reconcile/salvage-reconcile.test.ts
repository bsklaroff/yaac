import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SessionPod } from '#platform/k8s/pods'
import type * as podsModule from '#platform/k8s/pods'

const mockSalvage = vi.hoisted(() => vi.fn())
vi.mock('#features/images/image-promoter', () => ({
  salvageSessionImages: mockSalvage,
}))

const mockListPods = vi.hoisted(() => vi.fn())
vi.mock('#platform/k8s/pods', async (importOriginal) => ({
  ...(await importOriginal<typeof podsModule>()),
  listSessionPods: mockListPods,
}))

const mockGetWatcher = vi.hoisted(() => vi.fn())
vi.mock('#platform/k8s/pod-watch', () => ({
  getActivePodWatcher: mockGetWatcher,
}))

import {
  reconcileImageSalvage,
  SALVAGE_INTERVAL_MS,
  _resetSalvageReconcileForTests,
} from '#features/sessions/reconcile/salvage-reconcile'
import { markSessionTerminating, _clearTerminatingForTests } from '#features/sessions/state'

function pod(sessionId: string, over: Partial<SessionPod> = {}): SessionPod {
  return {
    jobName: `yaac-p-${sessionId}`,
    podName: `yaac-p-${sessionId}-x1`,
    sessionId,
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
  mockGetWatcher.mockReset().mockReturnValue(null)
  _resetSalvageReconcileForTests()
  _clearTerminatingForTests()
})

describe('reconcileImageSalvage', () => {
  it('salvages running sessions, throttled to the interval', async () => {
    mockListPods.mockResolvedValue([pod('s1')])
    await reconcileImageSalvage(1_000)
    expect(mockSalvage).toHaveBeenCalledTimes(1)
    expect(mockSalvage).toHaveBeenCalledWith({
      jobName: 'yaac-p-s1', projectSlug: 'p', sessionId: 's1',
    })

    // Within the interval: no re-run.
    await reconcileImageSalvage(1_000 + SALVAGE_INTERVAL_MS - 1)
    expect(mockSalvage).toHaveBeenCalledTimes(1)

    // Interval elapsed: runs again.
    await reconcileImageSalvage(1_000 + SALVAGE_INTERVAL_MS)
    expect(mockSalvage).toHaveBeenCalledTimes(2)
  })

  it('skips prewarmed spares, terminating pods, and yaac-marked terminating sessions', async () => {
    markSessionTerminating('s-marked')
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
    const getPods = vi.fn().mockReturnValue([pod('s-watched')])
    mockGetWatcher.mockReturnValue({ getPods })
    await reconcileImageSalvage(1_000)
    expect(getPods).toHaveBeenCalled()
    expect(mockListPods).not.toHaveBeenCalled()
    expect(mockSalvage).toHaveBeenCalledTimes(1)

    mockGetWatcher.mockReturnValue(null)
    mockListPods.mockRejectedValue(new Error('cluster down'))
    await expect(reconcileImageSalvage(2_000)).resolves.toBeUndefined()
  })
})
