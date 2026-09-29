import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type * as createModule from '#domain/worktrees/create'

// The create is the boundary: past it lies the substrate. What is real is
// everything that decides what it runs.
vi.mock('#domain/worktrees/create', async (importOriginal) => ({
  ...(await importOriginal<typeof createModule>()),
  createWorktree: vi.fn(),
}))

import { createWorktree, type WorktreeCreateResult } from '#domain/worktrees/create'
import { startWorktree } from '#domain/worktrees'
import { clearAllProvisioningForTests, listProvisioning } from '#domain/worktrees/provisioning'
import { getProjectRow, recordProject } from '#db/project-store'
import { closeDb } from '#db/client'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { installFakeWorktreeDriver, resetWorktreeDriver } from '@yaac/test-utils/fake-driver'

const mockCreate = vi.mocked(createWorktree)
let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  clearAllProvisioningForTests()
  await recordProject({ slug: 'proj', remoteUrl: 'https://example.com/proj', addedAt: '2026-01-01T00:00:00.000Z' })
  mockCreate.mockReset().mockImplementation((_slug, opts) => Promise.resolve({
    worktreeId: opts.worktreeId ?? 'x', jobName: 'j', forwardedPorts: [], tool: opts.tool ?? 'claude', mode: 'tui',
  } as WorktreeCreateResult))
})

afterEach(async () => {
  resetWorktreeDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('startWorktree', () => {
  it('resolves the setup, shows its row, and creates cold when no spare is wanted', async () => {
    const list = vi.fn(() => Promise.resolve([]))
    installFakeWorktreeDriver({ list })
    let row: ReturnType<typeof listProvisioning>[number] | undefined
    mockCreate.mockImplementation(() => {
      row = listProvisioning().find((p) => p.worktreeId === 'wt-1')
      return Promise.resolve({ worktreeId: 'wt-1', jobName: 'j', forwardedPorts: [], tool: 'claude', mode: 'tui' })
    })

    const result = await startWorktree({
      projectSlug: 'proj',
      worktreeId: 'wt-1',
      tool: 'claude',
      model: 'claude-opus-5-5',
      permissionMode: 'plan',
      branch: 'release',
      prompt: 'go',
      rememberDefaults: false,
      claimSpare: false,
    }, () => {})

    expect(result.worktreeId).toBe('wt-1')
    // The row names what is coming up before any agent has answered.
    expect(row).toMatchObject({ kind: 'create', tool: 'claude', model: 'claude-opus-5-5', modelName: 'Opus 5.5' })
    expect(mockCreate).toHaveBeenCalledWith('proj', expect.objectContaining({
      worktreeId: 'wt-1', tool: 'claude', model: 'claude-opus-5-5', permissionMode: 'plan',
      mode: 'tui', branch: 'release', initialPrompt: 'go',
    }))
    // No spare was looked for, and nothing was remembered for the project.
    expect(list).not.toHaveBeenCalled()
    expect((await getProjectRow('proj'))?.lastTool).toBeUndefined()
  })

  it('remembers what a person named, and looks for a spare before creating', async () => {
    const list = vi.fn(() => Promise.resolve([]))
    installFakeWorktreeDriver({ list })

    await startWorktree({
      projectSlug: 'proj',
      worktreeId: 'wt-2',
      tool: 'codex',
      permissionMode: 'accept-edits',
      rememberDefaults: true,
      claimSpare: true,
    }, () => {})

    expect(list).toHaveBeenCalled()
    expect(await getProjectRow('proj')).toMatchObject({
      lastTool: 'codex',
      createDefaults: { codex: { permissionMode: 'accept-edits' } },
    })
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })
})
