import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@yaac/server/platform/k8s/pods', async (importOriginal) => {
  const actual = await importOriginal<typeof podsModule>()
  return {
    ...actual,
    listSessionPods: vi.fn(),
    listSessionJobs: vi.fn(),
  }
})

vi.mock('@yaac/server/features/sessions/cleanup', async (importOriginal) => {
  const actual = await importOriginal<typeof cleanupModule>()
  return {
    ...actual,
    cleanupSessionDetached: vi.fn().mockResolvedValue(undefined),
  }
})

import { worktreeStop } from '#commands/worktree-stop'
import { stopWorktree } from '@yaac/server/features/sessions/stop'
import { listSessionPods, listSessionJobs, type SessionPod } from '@yaac/server/platform/k8s/pods'
import type * as podsModule from '@yaac/server/platform/k8s/pods'
import { cleanupSessionDetached } from '@yaac/server/features/sessions/cleanup'
import type * as cleanupModule from '@yaac/server/features/sessions/cleanup'
import { setDataDir } from '@yaac/shared/project-paths'

const mockListPods = vi.mocked(listSessionPods)
const mockListJobs = vi.mocked(listSessionJobs)
const cleanupSpy = vi.mocked(cleanupSessionDetached)

describe('worktreeStop', () => {
  it('is exported as a function', () => {
    expect(typeof worktreeStop).toBe('function')
  })
})

/**
 * Unit coverage for `stopWorktree`: the prefix-matching logic, the
 * NOT_FOUND / RUNTIME_UNAVAILABLE error shapes, the pod-less-Job
 * fallback, and the handoff to `cleanupSessionDetached` with the matched
 * session's metadata. Uses mocked pod/Job listings so no cluster is
 * needed.
 *
 * The actual reap-the-Job behaviour is exercised end-to-end by the
 * e2e session-delete tests.
 */
describe('stopWorktree', () => {
  beforeEach(() => {
    setDataDir('/tmp/unit-session-delete')
    mockListPods.mockReset()
    mockListJobs.mockReset()
    mockListJobs.mockResolvedValue([])
    cleanupSpy.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function pod(overrides: Partial<SessionPod> = {}): SessionPod {
    return {
      jobName: 'yaac-demo-abcd1234',
      podName: 'yaac-demo-abcd1234-p0d42',
      sessionId: 'abcd1234',
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

  it('resolves by exact session-id and hands the match to cleanupSessionDetached', async () => {
    mockListPods.mockResolvedValueOnce([pod()])
    const info = await stopWorktree('abcd1234')
    expect(info).toEqual({
      jobName: 'yaac-demo-abcd1234',
      worktreeId: 'abcd1234',
      projectSlug: 'demo',
    })
    // Cleanup is pod-scoped and still speaks sessionId; the returned info is
    // worktree-scoped.
    expect(cleanupSpy).toHaveBeenCalledWith({
      jobName: info.jobName, projectSlug: info.projectSlug, sessionId: info.worktreeId,
    })
  })

  it('resolves by session-id prefix', async () => {
    mockListPods.mockResolvedValueOnce([pod()])
    const info = await stopWorktree('abcd')
    expect(info.worktreeId).toBe('abcd1234')
    expect(cleanupSpy).toHaveBeenCalledTimes(1)
  })

  it('resolves by full job name', async () => {
    mockListPods.mockResolvedValueOnce([pod()])
    const info = await stopWorktree('yaac-demo-abcd1234')
    expect(info.jobName).toBe('yaac-demo-abcd1234')
  })

  it('resolves by exact pod name', async () => {
    mockListPods.mockResolvedValueOnce([pod({ podName: 'deadbeef00000000' })])
    const info = await stopWorktree('deadbeef00000000')
    expect(info.worktreeId).toBe('abcd1234')
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
      sessionId: 'podless1',
      projectSlug: 'demo',
      createdAtMs: 1_700_000_000_000,
    }])
    const info = await stopWorktree('podless')
    expect(info).toEqual({
      jobName: 'yaac-demo-podless1',
      worktreeId: 'podless1',
      projectSlug: 'demo',
    })
    // Cleanup is pod-scoped and still speaks sessionId; the returned info is
    // worktree-scoped.
    expect(cleanupSpy).toHaveBeenCalledWith({
      jobName: info.jobName, projectSlug: info.projectSlug, sessionId: info.worktreeId,
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
