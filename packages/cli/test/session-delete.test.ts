import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@yaac/server/lib/k8s/pods', async (importOriginal) => {
  const actual = await importOriginal<typeof podsModule>()
  return {
    ...actual,
    listSessionPods: vi.fn(),
    listSessionJobs: vi.fn(),
  }
})

vi.mock('@yaac/server/lib/session/cleanup', async (importOriginal) => {
  const actual = await importOriginal<typeof cleanupModule>()
  return {
    ...actual,
    cleanupSessionDetached: vi.fn().mockResolvedValue(undefined),
  }
})

import { sessionDelete } from '#commands/session-delete'
import { deleteSession } from '@yaac/server/lib/session/delete'
import { listSessionPods, listSessionJobs, type SessionPod } from '@yaac/server/lib/k8s/pods'
import type * as podsModule from '@yaac/server/lib/k8s/pods'
import { cleanupSessionDetached } from '@yaac/server/lib/session/cleanup'
import type * as cleanupModule from '@yaac/server/lib/session/cleanup'
import { setDataDir } from '@yaac/shared/project-paths'

const mockListPods = vi.mocked(listSessionPods)
const mockListJobs = vi.mocked(listSessionJobs)
const cleanupSpy = vi.mocked(cleanupSessionDetached)

describe('sessionDelete', () => {
  it('is exported as a function', () => {
    expect(typeof sessionDelete).toBe('function')
  })
})

/**
 * Unit coverage for `deleteSession`: the prefix-matching logic, the
 * NOT_FOUND / RUNTIME_UNAVAILABLE error shapes, the pod-less-Job
 * fallback, and the handoff to `cleanupSessionDetached` with the matched
 * session's metadata. Uses mocked pod/Job listings so no cluster is
 * needed.
 *
 * The actual reap-the-Job behaviour is exercised end-to-end by the
 * e2e session-delete tests.
 */
describe('deleteSession', () => {
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
    const info = await deleteSession('abcd1234')
    expect(info).toEqual({
      jobName: 'yaac-demo-abcd1234',
      sessionId: 'abcd1234',
      projectSlug: 'demo',
    })
    expect(cleanupSpy).toHaveBeenCalledWith(info)
  })

  it('resolves by session-id prefix', async () => {
    mockListPods.mockResolvedValueOnce([pod()])
    const info = await deleteSession('abcd')
    expect(info.sessionId).toBe('abcd1234')
    expect(cleanupSpy).toHaveBeenCalledTimes(1)
  })

  it('resolves by full job name', async () => {
    mockListPods.mockResolvedValueOnce([pod()])
    const info = await deleteSession('yaac-demo-abcd1234')
    expect(info.jobName).toBe('yaac-demo-abcd1234')
  })

  it('resolves by exact pod name', async () => {
    mockListPods.mockResolvedValueOnce([pod({ podName: 'deadbeef00000000' })])
    const info = await deleteSession('deadbeef00000000')
    expect(info.sessionId).toBe('abcd1234')
  })

  it('schedules cleanup even for a non-running pod', async () => {
    mockListPods.mockResolvedValueOnce([pod({ running: false, phase: 'Failed' })])
    const info = await deleteSession('abcd1234')
    expect(info.sessionId).toBe('abcd1234')
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
    const info = await deleteSession('podless')
    expect(info).toEqual({
      jobName: 'yaac-demo-podless1',
      sessionId: 'podless1',
      projectSlug: 'demo',
    })
    expect(cleanupSpy).toHaveBeenCalledWith(info)
  })

  it('throws NOT_FOUND when neither a pod nor a Job matches', async () => {
    mockListPods.mockResolvedValueOnce([])
    await expect(deleteSession('missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(cleanupSpy).not.toHaveBeenCalled()
  })

  it('throws RUNTIME_UNAVAILABLE when the pod list call fails', async () => {
    mockListPods.mockRejectedValueOnce(new Error('connection refused'))
    await expect(deleteSession('abcd1234')).rejects.toMatchObject({
      code: 'RUNTIME_UNAVAILABLE',
    })
    expect(cleanupSpy).not.toHaveBeenCalled()
  })

  it('throws RUNTIME_UNAVAILABLE when the Job-list fallback fails', async () => {
    mockListPods.mockResolvedValueOnce([])
    mockListJobs.mockRejectedValueOnce(new Error('connection refused'))
    await expect(deleteSession('abcd1234')).rejects.toMatchObject({
      code: 'RUNTIME_UNAVAILABLE',
    })
    expect(cleanupSpy).not.toHaveBeenCalled()
  })
})
