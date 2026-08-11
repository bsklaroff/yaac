import { describe, it, expect, vi, beforeEach } from 'vitest'
import { installFakeWorktreeRuntime } from '@yaac/test-utils/fake-runtime'
import type * as cleanupModule from '#domain/worktrees/cleanup'
import type * as createModule from '#domain/worktrees/create'

vi.mock('#records/worktree-store', () => ({
  clearWorktreeStopped: vi.fn().mockResolvedValue(undefined),
  findWorktreeRow: vi.fn().mockResolvedValue(undefined),
}))

// A restart is three substrate calls bracketing two row reads, and the
// ORDER is what this file pins: resolve, tear the old runtime down, create
// against the same id, and only then clear the stop record.
vi.mock('#domain/worktrees/cleanup', async (importOriginal) => ({
  ...(await importOriginal<typeof cleanupModule>()),
  teardownForRestart: vi.fn(),
}))
vi.mock('#domain/worktrees/create', async (importOriginal) => ({
  ...(await importOriginal<typeof createModule>()),
  createWorktree: vi.fn(),
}))

import { restartWorktree } from '#domain/worktrees/restart'
import { clearWorktreeStopped } from '#records/worktree-store'
import { teardownForRestart } from '#domain/worktrees/cleanup'
import { createWorktree, type WorktreeCreateResult } from '#domain/worktrees/create'
import type { RuntimeHandle } from '#runtime/contract'

const mockFind = vi.fn()
const mockTeardown = vi.mocked(teardownForRestart)
const mockCreate = vi.mocked(createWorktree)
const mockClearDeleted = vi.mocked(clearWorktreeStopped)

function handle(workspaceId: string): RuntimeHandle {
  return {
    workspaceId,
    projectSlug: 'proj',
    jobName: `yaac-proj-${workspaceId}`,
    tool: 'claude',
    mode: 'tui',
    running: true,
    state: 'running',
    labels: {},
    createdAtMs: 0,
    prewarmed: false,
    terminating: false,
    deathCause: { reason: 'pod-stopped' },
  }
}

const CREATED: WorktreeCreateResult = {
  worktreeId: 'sid-1',
  jobName: 'yaac-proj-sid-1',
  mode: 'tui',
  forwardedPorts: [],
  tool: 'claude',
}

describe('restartWorktree', () => {
  beforeEach(() => {
    mockFind.mockReset().mockResolvedValue(handle('sid-1'))
    installFakeWorktreeRuntime({ find: mockFind })
    mockTeardown.mockReset().mockResolvedValue(undefined)
    mockCreate.mockReset().mockResolvedValue(CREATED)
    mockClearDeleted.mockClear()
  })

  it('tears down the old Job, resumes, and clears the deletion record', async () => {
    const result = await restartWorktree('sid-1')
    expect(result).toEqual(CREATED)
    expect(mockTeardown).toHaveBeenCalledWith({
      jobName: 'yaac-proj-sid-1', projectSlug: 'proj', workspaceId: 'sid-1',
    })
    expect(mockCreate).toHaveBeenCalledWith('proj', expect.objectContaining({
      resume: true, worktreeId: 'sid-1', tool: 'claude',
    }))
    // The resurrected session must not show a stale death from its previous
    // life — the record (stoppedAt + death cause) is dropped on success.
    expect(mockClearDeleted).toHaveBeenCalledWith('proj', 'sid-1')
  })

  it('keeps the deletion record when the resume fails', async () => {
    mockCreate.mockRejectedValue(new Error('image pull failed'))
    await expect(restartWorktree('sid-1')).rejects.toThrow('image pull failed')
    expect(mockClearDeleted).not.toHaveBeenCalled()
  })

  it('leaves the record alone when the session cannot be resolved', async () => {
    // resolveRestartTarget falls back to the recorded row; with no pods and
    // no row this throws NOT_FOUND — covered here only to pin that the
    // record is untouched when resolution fails.
    mockFind.mockResolvedValue(undefined)
    await expect(restartWorktree('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(mockClearDeleted).not.toHaveBeenCalled()
  })
})
