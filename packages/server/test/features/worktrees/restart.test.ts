import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('#features/records/worktree-store', () => ({
  clearWorktreeStopped: vi.fn().mockResolvedValue(undefined),
  findWorktreeRow: vi.fn().mockResolvedValue(undefined),
}))

import { restartWorktree } from '#features/worktrees/restart'
import { _resetHerdForTests, _setHerdForTests, type WorkspaceHandle } from '#herd'
import { clearWorktreeStopped } from '#features/records/worktree-store'
import type { WorktreeCreateResult } from '#features/worktrees/create'

// A restart is three herd calls bracketing two row reads, and the ORDER is
// what this file pins: resolve, tear the old runtime down, create against
// the same id, and only then clear the stop record.
const mockFind = vi.fn<(idOrName: string) => Promise<WorkspaceHandle | undefined>>()
const mockTeardown = vi.fn<
  (t: { jobName: string | null; projectSlug: string; workspaceId: string }) => Promise<void>
>()
const mockCreate = vi.fn<(slug: string, opts: unknown) => Promise<WorktreeCreateResult>>()
const mockClearDeleted = vi.mocked(clearWorktreeStopped)

function handle(workspaceId: string): WorkspaceHandle {
  return {
    workspaceId,
    projectSlug: 'proj',
    jobName: `yaac-proj-${workspaceId}`,
    tool: 'claude',
    running: true,
    state: 'running',
    labels: {},
    createdAtMs: 0,
    prewarmed: false,
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
    mockTeardown.mockReset().mockResolvedValue(undefined)
    mockCreate.mockReset().mockResolvedValue(CREATED)
    mockClearDeleted.mockClear()
    _setHerdForTests({
      workspaces: { find: mockFind, teardownForRestart: mockTeardown, create: mockCreate },
    })
  })

  afterEach(() => {
    _resetHerdForTests()
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
