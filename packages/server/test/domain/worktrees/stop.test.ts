import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type * as createModule from '#domain/worktrees/create'

// A stop drives the runtime's teardown (the fake driver's) and, once the
// stop is recorded, the create of whatever was queued after it — the
// create being the process boundary here.
vi.mock('#domain/worktrees/create', async (importOriginal) => ({
  ...(await importOriginal<typeof createModule>()),
  createWorktree: vi.fn(),
}))
vi.mock('#domain/worktrees/cleanup', () => ({ cleanupWorktreeDetached: vi.fn() }))

import { createWorktree, type WorktreeCreateResult } from '#domain/worktrees/create'
import { cleanupWorktreeDetached } from '#domain/worktrees/cleanup'
import { queueWorktree, stopWorktree } from '#domain/worktrees'
import { clearQueuedLaunchesForTests } from '#domain/worktrees/queued-worktrees'
import { clearAllProvisioningForTests } from '#domain/worktrees/provisioning'
import { getQueuedWorktreeRow } from '#db/queued-worktree-store'
import { recordProject } from '#db/project-store'
import { recordWorktreeCreated } from '#db/worktree-store'
import { closeDb } from '#db/client'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { installFakeWorktreeDriver, resetWorktreeDriver } from '@yaac/test-utils/fake-driver'

const mockCreate = vi.mocked(createWorktree)
let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  clearAllProvisioningForTests()
  clearQueuedLaunchesForTests()
  installFakeWorktreeDriver({
    findForTeardown: (id) => Promise.resolve(id === 'parent'
      ? { workspaceId: 'parent', projectSlug: 'proj', unitName: 'yaac-proj-parent' }
      : undefined),
  })
  await recordProject({ slug: 'proj', remoteUrl: 'https://example.com/proj', addedAt: '2026-01-01T00:00:00.000Z' })
  await recordWorktreeCreated({ projectSlug: 'proj', worktreeId: 'parent', baseBranch: 'main', permissionMode: 'auto' })
  vi.mocked(cleanupWorktreeDetached).mockReset().mockResolvedValue()
  mockCreate.mockReset().mockImplementation((_slug, opts) => Promise.resolve({
    worktreeId: opts.worktreeId ?? 'x', jobName: 'j', forwardedPorts: [], tool: 'claude', mode: 'tui',
  } as WorktreeCreateResult))
})

afterEach(async () => {
  resetWorktreeDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('stopWorktree', () => {
  it('tears the worktree down, then starts what was queued after it — only the top of a chain', async () => {
    const child = await queueWorktree('proj', { parent: 'parent', prompt: 'child', tool: 'claude' }, 'user')
    const sibling = await queueWorktree('proj', { parent: 'parent', prompt: 'sibling', tool: 'claude' }, 'user')
    const grandchild = await queueWorktree('proj', { parent: child.id, prompt: 'grandchild' }, 'user')

    expect(await stopWorktree('parent')).toMatchObject({ worktreeId: 'parent', projectSlug: 'proj' })
    expect(cleanupWorktreeDetached).toHaveBeenCalledWith(expect.objectContaining({ worktreeId: 'parent' }))

    // Both direct children start, together, from their stored settings.
    await vi.waitFor(() => { expect(mockCreate).toHaveBeenCalledTimes(2) })
    expect(mockCreate.mock.calls.map((c) => c[1].initialPrompt).sort()).toEqual(['child', 'sibling'])
    expect(mockCreate.mock.calls[0][1]).toMatchObject({ branch: 'main', permissionMode: 'auto' })
    await vi.waitFor(async () => {
      expect(await getQueuedWorktreeRow(child.id)).toBeUndefined()
      expect(await getQueuedWorktreeRow(sibling.id)).toBeUndefined()
    })
    // The grandchild waits on the worktree the child became, for ITS stop.
    const becameId = mockCreate.mock.calls.find((c) => c[1].initialPrompt === 'child')?.[1].worktreeId
    const waiting = await getQueuedWorktreeRow(grandchild.id)
    expect(waiting).toMatchObject({ parentWorktreeId: becameId })
    expect(waiting?.releasedAt).toBeUndefined()
  })

  it('refuses a worktree with nothing running', async () => {
    await expect(stopWorktree('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
