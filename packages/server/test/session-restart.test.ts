import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('#lib/k8s/pods', async (importOriginal) => {
  const actual = await importOriginal<typeof podsModule>()
  return {
    ...actual,
    listSessionPods: vi.fn(),
  }
})

vi.mock('#lib/session/cleanup', () => ({
  cleanupSession: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('#lib/session/deleted-store', () => ({
  clearSessionDeleted: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('#session-create', () => ({
  createSession: vi.fn(),
}))

import { restartSession } from '#lib/session/restart'
import { listSessionPods, type SessionPod } from '#lib/k8s/pods'
import type * as podsModule from '#lib/k8s/pods'
import { cleanupSession } from '#lib/session/cleanup'
import { clearSessionDeleted } from '#lib/session/deleted-store'
import { createSession, type SessionCreateResult } from '#session-create'

const mockListPods = vi.mocked(listSessionPods)
const mockCleanup = vi.mocked(cleanupSession)
const mockClearDeleted = vi.mocked(clearSessionDeleted)
const mockCreate = vi.mocked(createSession)

function pod(sessionId: string): SessionPod {
  return {
    jobName: `yaac-proj-${sessionId}`,
    podName: `yaac-proj-${sessionId}-x1`,
    sessionId,
    projectSlug: 'proj',
    tool: 'claude',
    phase: 'Running',
    running: true,
    terminating: false,
    createdAtMs: 0,
    labels: {},
  }
}

const CREATED: SessionCreateResult = {
  sessionId: 'sid-1',
  jobName: 'yaac-proj-sid-1',
  forwardedPorts: [],
  tool: 'claude',
}

describe('restartSession', () => {
  beforeEach(() => {
    mockListPods.mockReset().mockResolvedValue([pod('sid-1')])
    mockCleanup.mockClear()
    mockClearDeleted.mockClear()
    mockCreate.mockReset().mockResolvedValue(CREATED)
  })

  it('tears down the old Job, resumes, and clears the deletion record', async () => {
    const result = await restartSession('sid-1')
    expect(result).toEqual(CREATED)
    expect(mockCleanup).toHaveBeenCalledWith({
      jobName: 'yaac-proj-sid-1', projectSlug: 'proj', sessionId: 'sid-1',
    })
    expect(mockCreate).toHaveBeenCalledWith('proj', expect.objectContaining({
      resume: true, sessionId: 'sid-1', tool: 'claude',
    }))
    // The resurrected session must not show a stale death from its previous
    // life — the record (deletedAt + death cause) is dropped on success.
    expect(mockClearDeleted).toHaveBeenCalledWith('proj', 'sid-1')
  })

  it('keeps the deletion record when the resume fails', async () => {
    mockCreate.mockRejectedValue(new Error('image pull failed'))
    await expect(restartSession('sid-1')).rejects.toThrow('image pull failed')
    expect(mockClearDeleted).not.toHaveBeenCalled()
  })

  it('clears the record in the deleted-session (no live pod) path too', async () => {
    // resolveRestartTarget falls back to the worktree scan; with no pods and
    // no worktrees this throws NOT_FOUND — covered here only to pin that the
    // record is untouched when resolution fails.
    mockListPods.mockResolvedValue([])
    await expect(restartSession('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(mockClearDeleted).not.toHaveBeenCalled()
  })
})
