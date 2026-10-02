import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock only the substrate's listings; everything above them runs for real.
vi.mock('#drivers/k8s/substrate/pods', async (importOriginal) => ({
  ...(await importOriginal<typeof podsModule>()),
  listWorkspacePods: vi.fn(),
  listWorkspaceJobs: vi.fn(),
}))

import { listWorkspaceJobs, listWorkspacePods, type JobInfo, type PodInfo } from '#drivers/k8s/substrate/pods'
import type * as podsModule from '#drivers/k8s/substrate/pods'
import { createRuntimeSnapshot } from '#drivers/k8s/workspaces'

const mockPods = vi.mocked(listWorkspacePods)
const mockJobs = vi.mocked(listWorkspaceJobs)

function pod(workspaceId: string): PodInfo {
  return {
    podName: `yaac-p-${workspaceId}-x`,
    jobName: `yaac-p-${workspaceId}`,
    workspaceId,
    projectSlug: 'p',
    tool: 'claude',
    phase: 'Running',
    running: true,
    terminating: false,
    createdAtMs: 1_700_000_000_000,
    labels: {},
  } as PodInfo
}

function job(workspaceId: string): JobInfo {
  return { jobName: `yaac-p-${workspaceId}`, workspaceId, projectSlug: 'p', createdAtMs: 1_700_000_000_000 }
}

beforeEach(() => {
  mockPods.mockReset().mockResolvedValue([pod('live')])
  mockJobs.mockReset().mockResolvedValue([job('live'), job('stray')])
})

describe('createRuntimeSnapshot', () => {
  it('answers workspaces and stray units from one memoized read per source', async () => {
    const snap = createRuntimeSnapshot(false)

    expect(snap.resync).toBe(false)
    expect((await snap.workspaces()).map((w) => w.workspaceId)).toEqual(['live'])
    // A Job whose pod is gone is a stray unit; one with a live pod is not.
    expect(await snap.strayUnits()).toEqual([{
      workspaceId: 'stray', unitName: 'yaac-p-stray', projectSlug: 'p', createdAtMs: 1_700_000_000_000,
    }])
    await snap.workspaces()
    expect(mockPods).toHaveBeenCalledTimes(1)
    expect(mockJobs).toHaveBeenCalledTimes(1)
  })

  // Destructive callers must not mistake a failed listing for an empty one.
  it('rejects rather than resolving empty when a listing fails', async () => {
    mockJobs.mockRejectedValue(new Error('apiserver down'))

    await expect(createRuntimeSnapshot().strayUnits()).rejects.toThrow('apiserver down')
  })
})
