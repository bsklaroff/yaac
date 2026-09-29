import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { installRealWorktreeDriver } from '@yaac/test-utils/real-driver'

vi.mock('@yaac/server/drivers/k8s/substrate/pods', async (importOriginal) => {
  const actual = await importOriginal<typeof podsModule>()
  return {
    ...actual,
    listWorktreePods: vi.fn(),
    listWorktreeJobs: vi.fn(),
  }
})

vi.mock('@yaac/server/domain/worktrees/cleanup', async (importOriginal) => {
  const actual = await importOriginal<typeof cleanupModule>()
  return {
    ...actual,
    cleanupWorktreeDetached: vi.fn().mockResolvedValue(undefined),
  }
})

import { worktreeStop } from '#commands/worktree-stop'
import { stopWorktree } from '@yaac/server/domain/worktrees/stop'
import { listWorktreePods, listWorktreeJobs, type PodInfo } from '@yaac/server/drivers/k8s/substrate/pods'
import type * as podsModule from '@yaac/server/drivers/k8s/substrate/pods'
import { cleanupWorktreeDetached } from '@yaac/server/domain/worktrees/cleanup'
import type * as cleanupModule from '@yaac/server/domain/worktrees/cleanup'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { closeDb } from '@yaac/server/db/client'
import { recordWorktreeCreated } from '@yaac/server/db/worktree-store'

const mockListPods = vi.mocked(listWorktreePods)
const mockListJobs = vi.mocked(listWorktreeJobs)
const cleanupSpy = vi.mocked(cleanupWorktreeDetached)

describe('worktreeStop', () => {
  it('is exported as a function', () => {
    expect(typeof worktreeStop).toBe('function')
  })
})

/**
 * Unit coverage for `stopWorktree`: the prefix expansion over rows, the
 * NOT_FOUND / RUNTIME_UNAVAILABLE error shapes, the pod-less-Job
 * fallback, and the handoff to `cleanupWorktreeDetached` with the matched
 * session's metadata. Uses mocked pod/Job listings so no cluster is
 * needed.
 *
 * The actual reap-the-Job behaviour is exercised end-to-end by the
 * e2e session-delete tests.
 */
describe('stopWorktree', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    // The real k8s driver, with only `listWorktreePods`/`listWorktreeJobs`
    // mocked below: what this file exercises is the resolve-then-teardown
    // pipeline, so the driver has to be the real one.
    installRealWorktreeDriver()
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
      worktreeId: 'abcd1234',
      projectSlug: 'demo',
      tool: 'claude',
      phase: 'Running',
      running: true,
      terminating: false,
      createdAtMs: 1_700_000_000_000,
      labels: {},
      ...overrides,
    }
  }

  it('resolves by exact session-id and hands the match to cleanupWorktreeDetached', async () => {
    mockListPods.mockResolvedValueOnce([pod()])
    const info = await stopWorktree('abcd1234')
    expect(info).toEqual({
      jobName: 'yaac-demo-abcd1234',
      worktreeId: 'abcd1234',
      projectSlug: 'demo',
    })
    // Cleanup is pod-scoped and still speaks worktreeId; the returned info is
    // worktree-scoped.
    expect(cleanupSpy).toHaveBeenCalledWith({
      jobName: info.jobName, projectSlug: info.projectSlug, worktreeId: info.worktreeId,
    })
  })

  // Expanded over the recorded rows, then handed to the runtime exactly.
  it('resolves by worktree-id prefix', async () => {
    await recordWorktreeCreated({ projectSlug: 'demo', worktreeId: 'abcd1234' })
    mockListPods.mockResolvedValueOnce([pod()])
    const info = await stopWorktree('abcd')
    expect(info.worktreeId).toBe('abcd1234')
    expect(cleanupSpy).toHaveBeenCalledTimes(1)
  })

  // Unit names are the runtime's own: nothing a client sends is one.
  it('does not resolve a job or pod name', async () => {
    for (const name of ['yaac-demo-abcd1234', 'yaac-demo-abcd1234-p0d42']) {
      mockListPods.mockResolvedValueOnce([pod()])
      await expect(stopWorktree(name)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    }
    expect(cleanupSpy).not.toHaveBeenCalled()
  })

  it('schedules cleanup even for a non-running pod', async () => {
    mockListPods.mockResolvedValueOnce([pod({ running: false, phase: 'Failed' })])
    const info = await stopWorktree('abcd1234')
    expect(info.worktreeId).toBe('abcd1234')
    expect(cleanupSpy).toHaveBeenCalledTimes(1)
  })

  it('falls back to the Job list when the pod was deleted out-of-band', async () => {
    mockListPods.mockResolvedValueOnce([])
    mockListJobs.mockResolvedValueOnce([{
      jobName: 'yaac-demo-podless1',
      worktreeId: 'podless1',
      projectSlug: 'demo',
      createdAtMs: 1_700_000_000_000,
    }])
    const info = await stopWorktree('podless1')
    expect(info).toEqual({
      jobName: 'yaac-demo-podless1',
      worktreeId: 'podless1',
      projectSlug: 'demo',
    })
    // Cleanup is pod-scoped and still speaks worktreeId; the returned info is
    // worktree-scoped.
    expect(cleanupSpy).toHaveBeenCalledWith({
      jobName: info.jobName, projectSlug: info.projectSlug, worktreeId: info.worktreeId,
    })
  })

  it('throws NOT_FOUND when neither a pod nor a Job matches', async () => {
    mockListPods.mockResolvedValueOnce([])
    await expect(stopWorktree('missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(cleanupSpy).not.toHaveBeenCalled()
  })

  it('throws RUNTIME_UNAVAILABLE when the pod list call fails', async () => {
    mockListPods.mockRejectedValueOnce(new Error('connection refused'))
    await expect(stopWorktree('abcd1234')).rejects.toMatchObject({
      code: 'RUNTIME_UNAVAILABLE',
    })
    expect(cleanupSpy).not.toHaveBeenCalled()
  })

  it('throws RUNTIME_UNAVAILABLE when the Job-list fallback fails', async () => {
    mockListPods.mockResolvedValueOnce([])
    mockListJobs.mockRejectedValueOnce(new Error('connection refused'))
    await expect(stopWorktree('abcd1234')).rejects.toMatchObject({
      code: 'RUNTIME_UNAVAILABLE',
    })
    expect(cleanupSpy).not.toHaveBeenCalled()
  })
})
