import { describe, it, expect, vi, beforeEach } from 'vitest'
import { installFakeWorktreeDriver } from '@yaac/test-utils/fake-driver'
import type * as cleanupModule from '#domain/worktrees/cleanup'
import type * as createModule from '#domain/worktrees/create'

vi.mock('#db/worktree-store', () => ({
  clearWorktreeStopped: vi.fn().mockResolvedValue(undefined),
  findWorktreeRow: vi.fn().mockResolvedValue(undefined),
  listWorktreeRows: vi.fn().mockResolvedValue([]),
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

import { resolveRestartTarget, restartWorktree } from '#domain/worktrees/restart'
import { clearWorktreeStopped, findWorktreeRow, listWorktreeRows, type WorktreeRow } from '#db/worktree-store'
import { teardownForRestart } from '#domain/worktrees/cleanup'
import { createWorktree, type WorktreeCreateResult } from '#domain/worktrees/create'
import {
  clearAllProvisioningForTests,
  inFlightWorktreeIds,
  listProvisioning,
  registerProvisioning,
} from '#domain/worktrees/provisioning'
import type { RuntimeHandle } from '#drivers/contract'

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

function row(worktreeId: string, over: Partial<WorktreeRow> = {}): WorktreeRow {
  return {
    projectSlug: 'proj',
    worktreeId,
    createdAt: new Date(0),
    deathSeen: false,
    spare: false,
    permissionMode: 'bypass',
    ...over,
  }
}

/** The recorded rows prefix expansion runs over. */
function rows(...ids: string[]): void {
  vi.mocked(listWorktreeRows).mockResolvedValue(ids.map((id) => row(id)))
}

const CREATED: WorktreeCreateResult = {
  worktreeId: 'sid-1',
  jobName: 'yaac-proj-sid-1',
  mode: 'tui',
  forwardedPorts: [],
  tool: 'claude',
}

/**
 * Snapshot the provisioning registry at the moment the teardown runs — the
 * instant that matters, since that is when the reaper's window opens and a
 * successful restart has retired its row by the time it returns.
 */
function duringTeardown(): () => ReturnType<typeof listProvisioning> {
  let seen: ReturnType<typeof listProvisioning> = []
  mockTeardown.mockImplementation(() => {
    seen = listProvisioning()
    return Promise.resolve()
  })
  return () => seen
}

describe('restartWorktree', () => {
  beforeEach(() => {
    mockFind.mockReset().mockResolvedValue(handle('sid-1'))
    installFakeWorktreeDriver({ find: mockFind })
    mockTeardown.mockReset().mockResolvedValue(undefined)
    mockCreate.mockReset().mockResolvedValue(CREATED)
    mockClearDeleted.mockClear()
    vi.mocked(findWorktreeRow).mockReset().mockResolvedValue(undefined)
    rows('sid-1')
    clearAllProvisioningForTests()
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

  // The reaper interlock. `inFlightWorktreeIds` is the only thing exempting
  // a restart from the stale reaper's sweeps, and the reaper's teardown
  // `rm -rf`s the session dirs the create is about to mount — so being in
  // the registry by the time the teardown opens that window is the whole
  // property, not merely being in it eventually.
  it('is registered as in-flight before the teardown opens the window', async () => {
    const inFlightAtTeardown: string[][] = []
    mockTeardown.mockImplementation(() => {
      inFlightAtTeardown.push(inFlightWorktreeIds())
      return Promise.resolve()
    })

    await restartWorktree('sid-1')

    expect(inFlightAtTeardown).toEqual([['sid-1']])
    // Retired on success — `buildSnapshot` hides a worktree that still has a
    // row, so a surviving entry renders a permanent "Starting…" placeholder
    // instead of the worktree that just came up.
    expect(listProvisioning()).toEqual([])
  })

  // The registry is keyed on the RESOLVED id, so a restart addressed by
  // prefix — the ordinary CLI case — must retire that entry, not one named
  // by what was typed.
  it('retires the row for a restart addressed by id prefix', async () => {
    await restartWorktree('sid')
    expect(listProvisioning()).toEqual([])
  })

  // Same keying again: progress lands on the row of the resolved id, so a
  // prefix restart's row does not sit at "Starting…" for its whole run.
  it('mirrors progress onto the row it registered, and to the caller', async () => {
    const seen: string[] = []
    let rowAtCreate = ''
    mockCreate.mockImplementation(() => {
      rowAtCreate = listProvisioning()[0]?.message ?? ''
      return Promise.resolve(CREATED)
    })

    await restartWorktree('sid', { onProgress: (m) => seen.push(m) })

    expect(seen).toContain('Stopping session job yaac-proj-sid-1...')
    expect(rowAtCreate).toBe('Stopping session job yaac-proj-sid-1...')
  })

  it('keeps the row, marked failed, when the resume fails', async () => {
    mockCreate.mockRejectedValue(new Error('image pull failed'))

    await expect(restartWorktree('sid-1')).rejects.toThrow('image pull failed')

    expect(listProvisioning()).toEqual([expect.objectContaining({
      worktreeId: 'sid-1', error: 'image pull failed',
    })])
    // A failed restart stops shielding: its rollback already tore down what
    // it left, so it has nothing for the reaper to spare.
    expect(inFlightWorktreeIds()).toEqual([])
  })

  // A caller that registered nothing ahead of this is tracked all the same:
  // the reaper interlock is the restart's own. Read mid-flight, since a
  // successful restart retires the row on its way out.
  it('registers a restart nothing pre-registered, naming the resolved project', async () => {
    const rows = duringTeardown()

    await restartWorktree('sid-1')

    expect(rows()).toEqual([expect.objectContaining({
      worktreeId: 'sid-1', projectSlug: 'proj', tool: 'claude', kind: 'restart',
    })])
  })

  // The restarting row is all that stands in for the worktree while its
  // container is recreated — the snapshot hides the worktree itself — so it
  // has to say which sidebar group it belongs to, or the sidebar draws it at
  // the top of the list instead of in the section the user filed it under.
  // Only the row knows that; the pod that answered the resolve does not.
  it('files the row in the group the worktree row records', async () => {
    vi.mocked(findWorktreeRow).mockResolvedValue(row('sid-1', { groupId: 'grp-1' }))
    const rows = duringTeardown()

    await restartWorktree('sid-1')

    expect(rows()).toEqual([expect.objectContaining({ worktreeId: 'sid-1', groupId: 'grp-1' })])
  })

  // The route registers up front, and the sidebar sorts oldest-first. Re-registering would take a fresh
  // insertion order and jump the row to the bottom of a list the user is
  // already watching — which is what `ensure` avoids. Its MESSAGE is fair
  // game: progress legitimately overwrites that.
  it('leaves a pre-registered row in its original sidebar position', async () => {
    registerProvisioning({
      worktreeId: 'sid-1', projectSlug: 'proj', tool: 'claude', kind: 'restart',
    })
    registerProvisioning({
      worktreeId: 'younger', projectSlug: 'proj', tool: 'claude', kind: 'create',
    })
    const rows = duringTeardown()

    await restartWorktree('sid-1')

    expect(rows().map((r) => r.worktreeId)).toEqual(['sid-1', 'younger'])
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

describe('resolveRestartTarget', () => {
  beforeEach(() => {
    mockFind.mockReset().mockResolvedValue(undefined)
    installFakeWorktreeDriver({ find: mockFind })
    vi.mocked(findWorktreeRow).mockReset().mockResolvedValue(undefined)
  })

  // The runtime is asked by exact id only: a prefix is expanded over rows
  // first, and one naming several worktrees never reaches it.
  it('expands a unique prefix before asking the runtime, and refuses an ambiguous one', async () => {
    rows('sid-1', 'other-1')
    mockFind.mockResolvedValue(handle('sid-1'))
    expect(await resolveRestartTarget('sid')).toMatchObject({ worktreeId: 'sid-1', jobName: 'yaac-proj-sid-1' })
    expect(mockFind.mock.calls[0]?.[0]).toBe('sid-1')

    rows('sid-1', 'sid-2')
    mockFind.mockClear()
    await expect(resolveRestartTarget('sid')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(mockFind).not.toHaveBeenCalled()
  })

  it('answers a stopped worktree from its row, group and all', async () => {
    vi.mocked(findWorktreeRow).mockResolvedValue(row('sid-1', { groupId: 'grp-1' }))
    expect(await resolveRestartTarget('sid-1')).toEqual({
      projectSlug: 'proj', worktreeId: 'sid-1', tool: 'claude', jobName: null, groupId: 'grp-1',
    })
  })
})
