import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { startWorkspace } from '#domain/workspaces'
import { clearAllProvisioningForTests, listProvisioning } from '#domain/workspaces/provisioning'
import { getProjectRow, getWorkspaceRow, listWorkspaceAgentSessions } from '#db'
import { closeDb } from '#db/client'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { handleFixture, installFakeWorkspaceDriver, resetWorkspaceDriver } from '@yaac/test-utils/fake-driver'
import { seedProject } from '@yaac/test-utils/project-fixture'
import type { WorkspaceDriver } from '#drivers/contract'
import { BUILT_IN_USER_ID } from '#db'

/** The caller of every user-caused write here. */
const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const

const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'

// Everything runs for real down to the fake driver, over a real project.
let tmpDir: string
let launched: string[]
/** Install the driver, recording launches; `list` is the spare lookup. */
function installDriver(overrides: Partial<WorkspaceDriver> = {}): void {
  installFakeWorkspaceDriver({
    launch: (spec) => {
      launched.push(spec.workspaceId)
      return Promise.resolve(handleFixture({ workspaceId: spec.workspaceId, projectId: PROJ }))
    },
    ...overrides,
  })
}

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await seedProject(PROJ)
  clearAllProvisioningForTests()
  launched = []
})

afterEach(async () => {
  vi.unstubAllEnvs()
  resetWorkspaceDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('startWorkspace', () => {
  it('resolves the setup, shows its row, and creates cold when no spare is wanted', async () => {
    const list = vi.fn(() => Promise.resolve([]))
    let row: ReturnType<typeof listProvisioning>[number] | undefined
    installDriver({
      list,
      prepareImage: () => {
        row = listProvisioning().find((p) => p.workspaceId === 'wt-1')
        return Promise.resolve('img')
      },
    })

    const result = await startWorkspace(local, {
      projectId: PROJ,
      workspaceId: 'wt-1',
      tool: 'claude',
      model: 'claude-opus-5-5',
      permissionMode: 'plan',
      mode: 'tui',
      branch: 'dev',
      prompt: 'go',
      rememberDefaults: false,
      claimSpare: false,
    }, () => {})

    expect(result.workspaceId).toBe('wt-1')
    // The row names what is coming up before any agent has answered.
    expect(row).toMatchObject({ kind: 'create', tool: 'claude', model: 'claude-opus-5-5', modelName: 'Opus 5.5' })
    expect(await getWorkspaceRow(PROJ, 'wt-1')).toMatchObject({
      model: 'claude-opus-5-5', permissionMode: 'plan', mode: 'tui', baseBranch: 'dev',
    })
    expect(await listWorkspaceAgentSessions(PROJ, 'wt-1')).toEqual([
      expect.objectContaining({ tool: 'claude', firstPrompt: 'go' }),
    ])
    // No spare was looked for, and nothing was remembered for the project.
    expect(list).not.toHaveBeenCalled()
    const project = await getProjectRow(PROJ)
    expect(project?.lastTool).toBeUndefined()
    expect(project?.lastBranch).toBeUndefined()
  })

  it('remembers what a person named, and looks for a spare before creating', async () => {
    const list = vi.fn(() => Promise.resolve([]))
    installDriver({ list })

    await startWorkspace(local, {
      projectId: PROJ,
      workspaceId: 'wt-2',
      tool: 'codex',
      permissionMode: 'accept-edits',
      branch: 'dev',
      rememberDefaults: true,
      claimSpare: true,
    }, () => {})

    expect(list).toHaveBeenCalled()
    expect(await getProjectRow(PROJ)).toMatchObject({
      lastTool: 'codex',
      lastBranch: 'dev',
      createDefaults: { codex: { permissionMode: 'accept-edits' } },
    })
    expect(launched).toEqual(['wt-2'])
  })
})
