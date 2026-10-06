import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PodInfo } from '#drivers/k8s/substrate/pods'
import type * as podsModule from '#drivers/k8s/substrate/pods'

const mockSalvage = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/images/image-promoter', () => ({
  salvageJobImages: mockSalvage,
}))

const mockListPods = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/substrate/pods', async (importOriginal) => ({
  ...(await importOriginal<typeof podsModule>()),
  listWorkspacePods: mockListPods,
}))


import {
  reconcileImageSalvage,
  SALVAGE_INTERVAL_MS,
  _resetSalvageReconcileForTests,
} from '#drivers/k8s/workspaces/salvage-reconcile'
import {
  isWorkspaceTerminating,
  markWorkspaceTerminating,
  _clearTerminatingForTests,
} from '#runtime/status/terminating'
import { setActiveClusterCache, type ClusterCache } from '#drivers/k8s/substrate/cluster-cache'

const PROJECT_ID = '3f2a9c1e-7b4d-4e8a-9c2f-5d6e7f8a9b0c'

function pod(workspaceId: string, over: Partial<PodInfo> = {}): PodInfo {
  return {
    jobName: `yaac-p-${workspaceId}`,
    podName: `yaac-p-${workspaceId}-x1`,
    workspaceId,
    projectId: PROJECT_ID,
    tool: 'claude',
    phase: 'Running',
    running: true,
    terminating: false,
    createdAtMs: 0,
    // Salvage only visits nested-engine workspaces. The label is written out
    // rather than imported so that renaming it breaks this test.
    labels: { 'yaac.nested': 'true' },
    ...over,
  }
}

beforeEach(() => {
  mockSalvage.mockReset().mockResolvedValue(true)
  mockListPods.mockReset().mockResolvedValue([])
  setActiveClusterCache(null)
  _resetSalvageReconcileForTests()
  _clearTerminatingForTests()
})

describe('reconcileImageSalvage', () => {
  it('salvages running sessions, throttled to the interval', async () => {
    mockListPods.mockResolvedValue([pod('s1')])
    await reconcileImageSalvage(isWorkspaceTerminating, 1_000)
    expect(mockSalvage).toHaveBeenCalledTimes(1)
    expect(mockSalvage).toHaveBeenCalledWith({
      jobName: 'yaac-p-s1', projectId: PROJECT_ID, workspaceId: 's1',
    })

    await reconcileImageSalvage(isWorkspaceTerminating, 1_000 + SALVAGE_INTERVAL_MS - 1)
    expect(mockSalvage).toHaveBeenCalledTimes(1)

    await reconcileImageSalvage(isWorkspaceTerminating, 1_000 + SALVAGE_INTERVAL_MS)
    expect(mockSalvage).toHaveBeenCalledTimes(2)
  })

  it('skips prewarmed spares, terminating pods, and yaac-marked terminating sessions', async () => {
    markWorkspaceTerminating('s-marked')
    mockListPods.mockResolvedValue([
      pod('s-prewarm', { labels: { 'yaac.nested': 'true', 'yaac.prewarmed': 'true' } }),
      pod('s-term', { terminating: true }),
      pod('s-marked'),
      pod('s-stopped', { running: false }),
    ])
    await reconcileImageSalvage(isWorkspaceTerminating, 1_000)
    expect(mockSalvage).not.toHaveBeenCalled()
  })

  it('never probes a workspace that has no in-pod engine', async () => {
    // Without an engine, podman writes state to a relative path, so the
    // probe would leave a root-owned directory in the user's checkout.
    mockListPods.mockResolvedValue([pod('s-plain', { labels: {} }), pod('s-nested')])
    await reconcileImageSalvage(isWorkspaceTerminating, 1_000)
    expect(mockSalvage).toHaveBeenCalledOnce()
    expect(mockSalvage).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 's-nested' }))
  })

  it('prunes throttle state for sessions that went away (no leak, fresh session re-runs)', async () => {
    mockListPods.mockResolvedValue([pod('s1')])
    await reconcileImageSalvage(isWorkspaceTerminating, 1_000)
    // Workspace gone, so its timestamp is pruned
    mockListPods.mockResolvedValue([])
    await reconcileImageSalvage(isWorkspaceTerminating, 2_000)
    // and a successor with the same id is salvaged immediately.
    mockListPods.mockResolvedValue([pod('s1')])
    await reconcileImageSalvage(isWorkspaceTerminating, 3_000)
    expect(mockSalvage).toHaveBeenCalledTimes(2)
  })

  it('prefers the pod watcher cache and survives a pod-list failure', async () => {
    const workspacePods = vi.fn().mockReturnValue([pod('s-watched')])
    setActiveClusterCache({ healthy: () => true, workspacePods } as unknown as ClusterCache)
    await reconcileImageSalvage(isWorkspaceTerminating, 1_000)
    expect(workspacePods).toHaveBeenCalled()
    expect(mockListPods).not.toHaveBeenCalled()
    expect(mockSalvage).toHaveBeenCalledTimes(1)

    setActiveClusterCache(null)
    mockListPods.mockRejectedValue(new Error('cluster down'))
    await expect(reconcileImageSalvage(isWorkspaceTerminating, 2_000)).resolves.toBeUndefined()
  })
})
