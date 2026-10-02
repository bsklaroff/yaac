import { describe, it, expect, vi, beforeEach } from 'vitest'
import { installFakeWorkspaceDriver } from '@yaac/test-utils/fake-driver'
import type * as cleanupModule from '#domain/workspaces/cleanup'
import type * as createModule from '#domain/workspaces/create'

vi.mock('#db/workspace-store', () => ({
  clearWorkspaceStopped: vi.fn().mockResolvedValue(undefined),
  findWorkspaceRow: vi.fn().mockResolvedValue(undefined),
  listWorkspaceRows: vi.fn().mockResolvedValue([]),
}))

// This file pins the restart order: resolve, tear down the old runtime,
// create under the same id, and only then clear the stop record.
vi.mock('#domain/workspaces/cleanup', async (importOriginal) => ({
  ...(await importOriginal<typeof cleanupModule>()),
  teardownForRestart: vi.fn(),
}))
vi.mock('#domain/workspaces/create', async (importOriginal) => ({
  ...(await importOriginal<typeof createModule>()),
  createWorkspace: vi.fn(),
}))

import { resolveRestartTarget, restartWorkspace } from '#domain/workspaces/restart'
import { clearWorkspaceStopped, findWorkspaceRow, listWorkspaceRows, type WorkspaceRow } from '#db/workspace-store'
import { teardownForRestart } from '#domain/workspaces/cleanup'
import { createWorkspace, type WorkspaceCreateResult } from '#domain/workspaces/create'
import {
  clearAllProvisioningForTests,
  inFlightWorkspaceIds,
  listProvisioning,
  registerProvisioning,
} from '#domain/workspaces/provisioning'
import type { RuntimeHandle } from '#drivers/contract'

const mockFind = vi.fn()
const mockTeardown = vi.mocked(teardownForRestart)
const mockCreate = vi.mocked(createWorkspace)
const mockClearDeleted = vi.mocked(clearWorkspaceStopped)

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

function row(workspaceId: string, over: Partial<WorkspaceRow> = {}): WorkspaceRow {
  return {
    projectSlug: 'proj',
    workspaceId,
    createdAt: new Date(0),
    deathSeen: false,
    spare: false,
    permissionMode: 'bypass',
    ...over,
  }
}

/** Record workspace rows for prefix expansion. */
function rows(...ids: string[]): void {
  vi.mocked(listWorkspaceRows).mockResolvedValue(ids.map((id) => row(id)))
}

const CREATED: WorkspaceCreateResult = {
  workspaceId: 'sid-1',
  jobName: 'yaac-proj-sid-1',
  mode: 'tui',
  forwardedPorts: [],
  tool: 'claude',
}

/**
 * Snapshot the provisioning registry when the teardown runs. That is when
 * the reaper could strike, and a successful restart removes its row before
 * returning.
 */
function duringTeardown(): () => ReturnType<typeof listProvisioning> {
  let seen: ReturnType<typeof listProvisioning> = []
  mockTeardown.mockImplementation(() => {
    seen = listProvisioning()
    return Promise.resolve()
  })
  return () => seen
}

describe('restartWorkspace', () => {
  beforeEach(() => {
    mockFind.mockReset().mockResolvedValue(handle('sid-1'))
    installFakeWorkspaceDriver({ find: mockFind })
    mockTeardown.mockReset().mockResolvedValue(undefined)
    mockCreate.mockReset().mockResolvedValue(CREATED)
    mockClearDeleted.mockClear()
    vi.mocked(findWorkspaceRow).mockReset().mockResolvedValue(undefined)
    rows('sid-1')
    clearAllProvisioningForTests()
  })

  it('tears down the old Job, resumes, and clears the deletion record', async () => {
    const result = await restartWorkspace('sid-1')
    expect(result).toEqual(CREATED)
    expect(mockTeardown).toHaveBeenCalledWith({
      jobName: 'yaac-proj-sid-1', projectSlug: 'proj', workspaceId: 'sid-1',
    })
    expect(mockCreate).toHaveBeenCalledWith('proj', expect.objectContaining({
      resume: true, workspaceId: 'sid-1', tool: 'claude',
    }))
    // On success the stop record (stoppedAt and cause) is cleared.
    expect(mockClearDeleted).toHaveBeenCalledWith('proj', 'sid-1')
  })

  // The workspace is running by then, so a lost clear must not report it
  // as failed.
  it('succeeds when clearing the deletion record fails', async () => {
    mockClearDeleted.mockRejectedValueOnce(new Error('db write failed'))
    expect(await restartWorkspace('sid-1')).toEqual(CREATED)
    expect(listProvisioning()).toEqual([])
  })

  it('keeps the deletion record when the resume fails', async () => {
    mockCreate.mockRejectedValue(new Error('image pull failed'))
    await expect(restartWorkspace('sid-1')).rejects.toThrow('image pull failed')
    expect(mockClearDeleted).not.toHaveBeenCalled()
  })

  // `inFlightWorkspaceIds` is all that keeps the stale reaper from deleting
  // the dirs the create is about to mount, so the restart must be registered
  // before the teardown starts.
  it('is registered as in-flight before the teardown opens the window', async () => {
    const inFlightAtTeardown: string[][] = []
    mockTeardown.mockImplementation(() => {
      inFlightAtTeardown.push(inFlightWorkspaceIds())
      return Promise.resolve()
    })

    await restartWorkspace('sid-1')

    expect(inFlightAtTeardown).toEqual([['sid-1']])
    // Removed on success. `buildSnapshot` hides a workspace that still has a
    // row, so a leftover would show "Starting…" forever.
    expect(listProvisioning()).toEqual([])
  })

  // The registry is keyed on the resolved id, so a restart by prefix (the
  // usual CLI case) must remove that entry.
  it('retires the row for a restart addressed by id prefix', async () => {
    await restartWorkspace('sid')
    expect(listProvisioning()).toEqual([])
  })

  // Progress also goes to the resolved id's row.
  it('mirrors progress onto the row it registered, and to the caller', async () => {
    const seen: string[] = []
    let rowAtCreate = ''
    mockCreate.mockImplementation(() => {
      rowAtCreate = listProvisioning()[0]?.message ?? ''
      return Promise.resolve(CREATED)
    })

    await restartWorkspace('sid', { onProgress: (m) => seen.push(m) })

    expect(seen).toContain('Stopping session job yaac-proj-sid-1...')
    expect(rowAtCreate).toBe('Stopping session job yaac-proj-sid-1...')
  })

  it('keeps the row, marked failed, when the resume fails', async () => {
    mockCreate.mockRejectedValue(new Error('image pull failed'))

    await expect(restartWorkspace('sid-1')).rejects.toThrow('image pull failed')

    expect(listProvisioning()).toEqual([expect.objectContaining({
      workspaceId: 'sid-1', error: 'image pull failed',
    })])
    // A failed restart's rollback already tore everything down, so it no
    // longer shields anything from the reaper.
    expect(inFlightWorkspaceIds()).toEqual([])
  })

  // The restart registers itself if the caller did not. Read mid-flight,
  // since success removes the row.
  it('registers a restart nothing pre-registered, naming the resolved project', async () => {
    const rows = duringTeardown()

    await restartWorkspace('sid-1')

    expect(rows()).toEqual([expect.objectContaining({
      workspaceId: 'sid-1', projectSlug: 'proj', tool: 'claude', kind: 'restart',
    })])
  })

  // The snapshot hides the workspace while it restarts, so the row must
  // carry its sidebar group or it is drawn outside its section. Only the
  // workspace row records the group.
  it('files the row in the group the workspace row records', async () => {
    vi.mocked(findWorkspaceRow).mockResolvedValue(row('sid-1', { groupId: 'grp-1' }))
    const rows = duringTeardown()

    await restartWorkspace('sid-1')

    expect(rows()).toEqual([expect.objectContaining({ workspaceId: 'sid-1', groupId: 'grp-1' })])
  })

  // The route registers up front and the sidebar sorts oldest first.
  // Re-registering would move the row to the bottom, which `ensure` avoids.
  // Progress may still overwrite the message.
  it('leaves a pre-registered row in its original sidebar position', async () => {
    registerProvisioning({
      workspaceId: 'sid-1', projectSlug: 'proj', tool: 'claude', kind: 'restart',
    })
    registerProvisioning({
      workspaceId: 'younger', projectSlug: 'proj', tool: 'claude', kind: 'create',
    })
    const rows = duringTeardown()

    await restartWorkspace('sid-1')

    expect(rows().map((r) => r.workspaceId)).toEqual(['sid-1', 'younger'])
  })

  it('leaves the record alone when the session cannot be resolved', async () => {
    // With no pod and no row, resolution throws NOT_FOUND; the stop record
    // must be left alone.
    mockFind.mockResolvedValue(undefined)
    await expect(restartWorkspace('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(mockClearDeleted).not.toHaveBeenCalled()
  })
})

describe('resolveRestartTarget', () => {
  beforeEach(() => {
    mockFind.mockReset().mockResolvedValue(undefined)
    installFakeWorkspaceDriver({ find: mockFind })
    vi.mocked(findWorkspaceRow).mockReset().mockResolvedValue(undefined)
  })

  // Prefixes are expanded over rows first; the runtime sees only exact ids.
  it('expands a unique prefix before asking the runtime, and refuses an ambiguous one', async () => {
    rows('sid-1', 'other-1')
    mockFind.mockResolvedValue(handle('sid-1'))
    expect(await resolveRestartTarget('sid')).toMatchObject({ workspaceId: 'sid-1', jobName: 'yaac-proj-sid-1' })
    expect(mockFind.mock.calls[0]?.[0]).toBe('sid-1')

    rows('sid-1', 'sid-2')
    mockFind.mockClear()
    await expect(resolveRestartTarget('sid')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(mockFind).not.toHaveBeenCalled()
  })

  it('answers a stopped workspace from its row, group and all', async () => {
    vi.mocked(findWorkspaceRow).mockResolvedValue(row('sid-1', { groupId: 'grp-1' }))
    expect(await resolveRestartTarget('sid-1')).toEqual({
      projectSlug: 'proj', workspaceId: 'sid-1', tool: 'claude', jobName: null, groupId: 'grp-1',
    })
  })
})
