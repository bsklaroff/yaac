import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { installRealWorkspaceDriver } from '@yaac/test-utils/real-driver'

vi.mock('@yaac/server/drivers/k8s/substrate/pods', async (importOriginal) => {
  const actual = await importOriginal<typeof podsModule>()
  return {
    ...actual,
    listWorkspacePods: vi.fn(),
    listWorkspaceJobs: vi.fn(),
  }
})

vi.mock('@yaac/server/domain/workspaces/cleanup', async (importOriginal) => {
  const actual = await importOriginal<typeof cleanupModule>()
  return {
    ...actual,
    cleanupWorkspaceDetached: vi.fn().mockResolvedValue(undefined),
  }
})

import { workspaceStop } from '#commands/workspace-stop'
import { stopWorkspace } from '@yaac/server/domain/workspaces/stop'
import { listWorkspacePods, listWorkspaceJobs, type PodInfo } from '@yaac/server/drivers/k8s/substrate/pods'
import type * as podsModule from '@yaac/server/drivers/k8s/substrate/pods'
import { cleanupWorkspaceDetached } from '@yaac/server/domain/workspaces/cleanup'
import type * as cleanupModule from '@yaac/server/domain/workspaces/cleanup'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { closeDb } from '@yaac/server/db/client'
import { recordWorkspaceCreated } from '@yaac/server/db/workspace-store'

const mockListPods = vi.mocked(listWorkspacePods)
const mockListJobs = vi.mocked(listWorkspaceJobs)
const cleanupSpy = vi.mocked(cleanupWorkspaceDetached)

describe('workspaceStop', () => {
  it('is exported as a function', () => {
    expect(typeof workspaceStop).toBe('function')
  })
})

/**
 * `stopWorkspace` against mocked pod/Job listings, so no cluster is needed.
 * Deleting the Job itself is covered by the e2e tests.
 */
describe('stopWorkspace', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    // The real k8s driver; only the pod/Job listings are mocked.
    installRealWorkspaceDriver()
    mockListPods.mockReset()
    mockListJobs.mockReset()
    mockListJobs.mockResolvedValue([])
    cleanupSpy.mockClear()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  function pod(overrides: Partial<PodInfo> = {}): PodInfo {
    return {
      jobName: 'yaac-demo-abcd1234',
      podName: 'yaac-demo-abcd1234-p0d42',
      workspaceId: 'abcd1234',
      projectSlug: 'demo',
      projectId: '3f2a9c1e-7b4d-4e8a-9c2f-5d6e7f8a9b0c',
      tool: 'claude',
      phase: 'Running',
      running: true,
      terminating: false,
      createdAtMs: 1_700_000_000_000,
      labels: {},
      ...overrides,
    }
  }

  it('resolves by exact session-id and hands the match to cleanupWorkspaceDetached', async () => {
    mockListPods.mockResolvedValueOnce([pod()])
    const info = await stopWorkspace('abcd1234')
    expect(info).toEqual({
      jobName: 'yaac-demo-abcd1234',
      workspaceId: 'abcd1234',
      projectSlug: 'demo',
    })
    expect(cleanupSpy).toHaveBeenCalledWith({
      jobName: info.jobName, projectSlug: info.projectSlug, workspaceId: info.workspaceId,
    })
  })

  it('resolves by workspace-id prefix', async () => {
    await recordWorkspaceCreated({ projectSlug: 'demo', workspaceId: 'abcd1234' })
    mockListPods.mockResolvedValueOnce([pod()])
    const info = await stopWorkspace('abcd')
    expect(info.workspaceId).toBe('abcd1234')
    expect(cleanupSpy).toHaveBeenCalledTimes(1)
  })

  // Job and pod names are internal; clients only send workspace ids.
  it('does not resolve a job or pod name', async () => {
    for (const name of ['yaac-demo-abcd1234', 'yaac-demo-abcd1234-p0d42']) {
      mockListPods.mockResolvedValueOnce([pod()])
      await expect(stopWorkspace(name)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    }
    expect(cleanupSpy).not.toHaveBeenCalled()
  })

  it('schedules cleanup even for a non-running pod', async () => {
    mockListPods.mockResolvedValueOnce([pod({ running: false, phase: 'Failed' })])
    const info = await stopWorkspace('abcd1234')
    expect(info.workspaceId).toBe('abcd1234')
    expect(cleanupSpy).toHaveBeenCalledTimes(1)
  })

  it('falls back to the Job list when the pod was deleted out-of-band', async () => {
    mockListPods.mockResolvedValueOnce([])
    mockListJobs.mockResolvedValueOnce([{
      jobName: 'yaac-demo-podless1',
      workspaceId: 'podless1',
      projectSlug: 'demo',
      createdAtMs: 1_700_000_000_000,
    }])
    const info = await stopWorkspace('podless1')
    expect(info).toEqual({
      jobName: 'yaac-demo-podless1',
      workspaceId: 'podless1',
      projectSlug: 'demo',
    })
    expect(cleanupSpy).toHaveBeenCalledWith({
      jobName: info.jobName, projectSlug: info.projectSlug, workspaceId: info.workspaceId,
    })
  })

  it('throws NOT_FOUND when neither a pod nor a Job matches', async () => {
    mockListPods.mockResolvedValueOnce([])
    await expect(stopWorkspace('missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(cleanupSpy).not.toHaveBeenCalled()
  })

  it('throws RUNTIME_UNAVAILABLE when the pod list call fails', async () => {
    mockListPods.mockRejectedValueOnce(new Error('connection refused'))
    await expect(stopWorkspace('abcd1234')).rejects.toMatchObject({
      code: 'RUNTIME_UNAVAILABLE',
    })
    expect(cleanupSpy).not.toHaveBeenCalled()
  })

  it('throws RUNTIME_UNAVAILABLE when the Job-list fallback fails', async () => {
    mockListPods.mockResolvedValueOnce([])
    mockListJobs.mockRejectedValueOnce(new Error('connection refused'))
    await expect(stopWorkspace('abcd1234')).rejects.toMatchObject({
      code: 'RUNTIME_UNAVAILABLE',
    })
    expect(cleanupSpy).not.toHaveBeenCalled()
  })
})
