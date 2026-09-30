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

const mockGetCache = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/substrate/cluster-cache', () => ({
  getActiveClusterCache: mockGetCache,
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

const PROJECT_ID = '3f2a9c1e-7b4d-4e8a-9c2f-5d6e7f8a9b0c'

function pod(workspaceId: string, over: Partial<PodInfo> = {}): PodInfo {
  return {
    jobName: `yaac-p-${workspaceId}`,
    podName: `yaac-p-${workspaceId}-x1`,
    workspaceId,
    projectSlug: 'p',
    projectId: PROJECT_ID,
    tool: 'claude',
    phase: 'Running',
    running: true,
    terminating: false,
    createdAtMs: 0,
    // Salvage only ever visits workspaces running the in-pod engine, so the
    // default fixture is one. The label is spelled out rather than imported
    // because it is a wire value a pod already in the cluster carries: a
    // rename that silently stopped matching live pods is exactly what this
    // should fail on.
    labels: { 'yaac.nested': 'true' },
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
    await reconcileImageSalvage(isWorkspaceTerminating, 1_000)
    expect(mockSalvage).toHaveBeenCalledTimes(1)
    expect(mockSalvage).toHaveBeenCalledWith({
      jobName: 'yaac-p-s1', project: { slug: 'p', id: PROJECT_ID }, workspaceId: 's1',
    })

    // Within the interval: no re-run.
    await reconcileImageSalvage(isWorkspaceTerminating, 1_000 + SALVAGE_INTERVAL_MS - 1)
    expect(mockSalvage).toHaveBeenCalledTimes(1)

    // Interval elapsed: runs again.
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
      // From before project ids: there is no id-named registry to push to.
      pod('s-legacy', { projectId: undefined }),
    ])
    await reconcileImageSalvage(isWorkspaceTerminating, 1_000)
    expect(mockSalvage).not.toHaveBeenCalled()
  })

  it('never probes a workspace that has no in-pod engine', async () => {
    // A workspace with no engine has no images of its own, so the survey it
    // would be sent can only report nothing. Skipping it here is not just
    // the saved exec: the in-pod script runs podman as root from the
    // container's workingDir — the user's checkout — and podman with no
    // engine configured writes its runtime state to a RELATIVE path, so
    // the probe leaves a root-owned directory in the workspace.
    mockListPods.mockResolvedValue([pod('s-plain', { labels: {} }), pod('s-nested')])
    await reconcileImageSalvage(isWorkspaceTerminating, 1_000)
    expect(mockSalvage).toHaveBeenCalledOnce()
    expect(mockSalvage).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 's-nested' }))
  })

  it('prunes throttle state for sessions that went away (no leak, fresh session re-runs)', async () => {
    mockListPods.mockResolvedValue([pod('s1')])
    await reconcileImageSalvage(isWorkspaceTerminating, 1_000)
    // Session gone → its stamp is pruned...
    mockListPods.mockResolvedValue([])
    await reconcileImageSalvage(isWorkspaceTerminating, 2_000)
    // ...so a same-id successor salvages immediately, not after the
    // stale stamp's interval.
    mockListPods.mockResolvedValue([pod('s1')])
    await reconcileImageSalvage(isWorkspaceTerminating, 3_000)
    expect(mockSalvage).toHaveBeenCalledTimes(2)
  })

  it('prefers the pod watcher cache and survives a pod-list failure', async () => {
    const workspacePods = vi.fn().mockReturnValue([pod('s-watched')])
    mockGetCache.mockReturnValue({ workspacePods })
    await reconcileImageSalvage(isWorkspaceTerminating, 1_000)
    expect(workspacePods).toHaveBeenCalled()
    expect(mockListPods).not.toHaveBeenCalled()
    expect(mockSalvage).toHaveBeenCalledTimes(1)

    mockGetCache.mockReturnValue(null)
    mockListPods.mockRejectedValue(new Error('cluster down'))
    await expect(reconcileImageSalvage(isWorkspaceTerminating, 2_000)).resolves.toBeUndefined()
  })
})
