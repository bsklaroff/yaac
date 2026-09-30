import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type * as createModule from '#domain/workspaces/create'

// Stub createWorkspace so the substrate is never touched; everything that
// decides what gets created runs for real.
vi.mock('#domain/workspaces/create', async (importOriginal) => ({
  ...(await importOriginal<typeof createModule>()),
  createWorkspace: vi.fn(),
}))

import { createWorkspace, type WorkspaceCreateResult } from '#domain/workspaces/create'
import { startWorkspace } from '#domain/workspaces'
import { clearAllProvisioningForTests, listProvisioning } from '#domain/workspaces/provisioning'
import { getProjectRow, recordProject } from '#db/project-store'
import { closeDb } from '#db/client'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { installFakeWorkspaceDriver, resetWorkspaceDriver } from '@yaac/test-utils/fake-driver'

const mockCreate = vi.mocked(createWorkspace)
let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  clearAllProvisioningForTests()
  await recordProject({ slug: 'proj', remoteUrl: 'https://example.com/proj', addedAt: '2026-01-01T00:00:00.000Z' })
  mockCreate.mockReset().mockImplementation((_slug, opts) => Promise.resolve({
    workspaceId: opts.workspaceId ?? 'x', jobName: 'j', forwardedPorts: [], tool: opts.tool ?? 'claude', mode: 'tui',
  } as WorkspaceCreateResult))
})

afterEach(async () => {
  resetWorkspaceDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('startWorkspace', () => {
  it('resolves the setup, shows its row, and creates cold when no spare is wanted', async () => {
    const list = vi.fn(() => Promise.resolve([]))
    installFakeWorkspaceDriver({ list })
    let row: ReturnType<typeof listProvisioning>[number] | undefined
    mockCreate.mockImplementation(() => {
      row = listProvisioning().find((p) => p.workspaceId === 'wt-1')
      return Promise.resolve({ workspaceId: 'wt-1', jobName: 'j', forwardedPorts: [], tool: 'claude', mode: 'tui' })
    })

    const result = await startWorkspace({
      projectSlug: 'proj',
      workspaceId: 'wt-1',
      tool: 'claude',
      model: 'claude-opus-5-5',
      permissionMode: 'plan',
      branch: 'release',
      prompt: 'go',
      rememberDefaults: false,
      claimSpare: false,
    }, () => {})

    expect(result.workspaceId).toBe('wt-1')
    // The row names what is coming up before any agent has answered.
    expect(row).toMatchObject({ kind: 'create', tool: 'claude', model: 'claude-opus-5-5', modelName: 'Opus 5.5' })
    expect(mockCreate).toHaveBeenCalledWith('proj', expect.objectContaining({
      workspaceId: 'wt-1', tool: 'claude', model: 'claude-opus-5-5', permissionMode: 'plan',
      mode: 'tui', branch: 'release', initialPrompt: 'go',
    }))
    // No spare was looked for, and nothing was remembered for the project.
    expect(list).not.toHaveBeenCalled()
    const project = await getProjectRow('proj')
    expect(project?.lastTool).toBeUndefined()
    expect(project?.lastBranch).toBeUndefined()
  })

  it('remembers what a person named, and looks for a spare before creating', async () => {
    const list = vi.fn(() => Promise.resolve([]))
    installFakeWorkspaceDriver({ list })

    await startWorkspace({
      projectSlug: 'proj',
      workspaceId: 'wt-2',
      tool: 'codex',
      permissionMode: 'accept-edits',
      branch: 'develop',
      rememberDefaults: true,
      claimSpare: true,
    }, () => {})

    expect(list).toHaveBeenCalled()
    expect(await getProjectRow('proj')).toMatchObject({
      lastTool: 'codex',
      lastBranch: 'develop',
      createDefaults: { codex: { permissionMode: 'accept-edits' } },
    })
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })
})
