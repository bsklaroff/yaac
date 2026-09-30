import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type * as createModule from '#domain/workspaces/create'

// A stop drives the runtime's teardown (the fake driver's) and, once the
// stop is recorded, the create of whatever was queued after it — the
// create being the process boundary here.
vi.mock('#domain/workspaces/create', async (importOriginal) => ({
  ...(await importOriginal<typeof createModule>()),
  createWorkspace: vi.fn(),
}))
vi.mock('#domain/workspaces/cleanup', () => ({ cleanupWorkspaceDetached: vi.fn() }))

import { createWorkspace, type WorkspaceCreateResult } from '#domain/workspaces/create'
import { cleanupWorkspaceDetached } from '#domain/workspaces/cleanup'
import { queueWorkspace, stopWorkspace } from '#domain/workspaces'
import { clearQueuedLaunchesForTests } from '#domain/workspaces/queued-workspaces'
import { clearAllProvisioningForTests } from '#domain/workspaces/provisioning'
import { getQueuedWorkspaceRow } from '#db/queued-workspace-store'
import { recordProject } from '#db/project-store'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { closeDb } from '#db/client'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { installFakeWorkspaceDriver, resetWorkspaceDriver } from '@yaac/test-utils/fake-driver'

const mockCreate = vi.mocked(createWorkspace)
let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  clearAllProvisioningForTests()
  clearQueuedLaunchesForTests()
  installFakeWorkspaceDriver({
    findForTeardown: (id) => Promise.resolve(id === 'parent'
      ? { workspaceId: 'parent', projectSlug: 'proj', unitName: 'yaac-proj-parent' }
      : undefined),
  })
  await recordProject({ slug: 'proj', remoteUrl: 'https://example.com/proj', addedAt: '2026-01-01T00:00:00.000Z' })
  await recordWorkspaceCreated({ projectSlug: 'proj', workspaceId: 'parent', baseBranch: 'main', permissionMode: 'auto' })
  vi.mocked(cleanupWorkspaceDetached).mockReset().mockResolvedValue()
  // A create records the workspace's row, as the real one does — a launched
  // entry keeps a foreign key to it.
  mockCreate.mockReset().mockImplementation(async (slug, opts) => {
    await recordWorkspaceCreated({ projectSlug: slug, workspaceId: opts.workspaceId ?? 'x' })
    return {
      workspaceId: opts.workspaceId ?? 'x', jobName: 'j', forwardedPorts: [], tool: 'claude', mode: 'tui',
    } as WorkspaceCreateResult
  })
})

afterEach(async () => {
  resetWorkspaceDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('stopWorkspace', () => {
  // An unclaimed spare is not a workspace: its exact id reaches the runtime
  // (no row knows it), but a stop never asks the runtime for spares.
  it('does not stop an unclaimed spare, even by its exact id', async () => {
    const asked: Array<{ spares?: boolean } | undefined> = []
    installFakeWorkspaceDriver({
      findForTeardown: (id, opts) => {
        asked.push(opts)
        return Promise.resolve(id === 'spare1' && opts?.spares === true
          ? { workspaceId: 'spare1', projectSlug: 'proj', unitName: 'yaac-proj-spare1' }
          : undefined)
      },
    })
    await expect(stopWorkspace('spare1')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(asked).toEqual([undefined])
    expect(cleanupWorkspaceDetached).not.toHaveBeenCalled()
  })

  it('tears the workspace down, then starts what was queued after it — only the top of a chain', async () => {
    const child = await queueWorkspace('proj', { parent: 'parent', prompt: 'child', tool: 'claude' }, 'user')
    const sibling = await queueWorkspace('proj', { parent: 'parent', prompt: 'sibling', tool: 'claude' }, 'user')
    const grandchild = await queueWorkspace('proj', { parent: child.id, prompt: 'grandchild' }, 'user')

    expect(await stopWorkspace('parent')).toMatchObject({ workspaceId: 'parent', projectSlug: 'proj' })
    expect(cleanupWorkspaceDetached).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'parent' }))

    // Both direct children start, together, from their stored settings.
    await vi.waitFor(() => { expect(mockCreate).toHaveBeenCalledTimes(2) })
    expect(mockCreate.mock.calls.map((c) => c[1].initialPrompt).sort()).toEqual(['child', 'sibling'])
    expect(mockCreate.mock.calls[0][1]).toMatchObject({ branch: 'main', permissionMode: 'auto' })
    await vi.waitFor(async () => {
      expect(await getQueuedWorkspaceRow(child.id)).toBeUndefined()
      expect(await getQueuedWorkspaceRow(sibling.id)).toBeUndefined()
    })
    // The grandchild waits on the workspace the child became, for ITS stop.
    const becameId = mockCreate.mock.calls.find((c) => c[1].initialPrompt === 'child')?.[1].workspaceId
    const waiting = await getQueuedWorkspaceRow(grandchild.id)
    expect(waiting).toMatchObject({ parentWorkspaceId: becameId })
    expect(waiting?.releasedAt).toBeUndefined()
  })

  it('refuses a workspace with nothing running', async () => {
    await expect(stopWorkspace('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
