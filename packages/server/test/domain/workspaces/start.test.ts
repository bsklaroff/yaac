import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { listDraftWorkspaces, saveDraftWorkspace, startWorkspace } from '#domain/workspaces'
import { clearAllProvisioningForTests, listProvisioning } from '#domain/workspaces/provisioning'
import { getProjectRow, getWorkspaceRow, listWorkspaceAgentSessions } from '#db'
import { closeDb } from '#db/client'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { handleFixture, installFakeWorkspaceDriver, resetWorkspaceDriver } from '@yaac/test-utils/fake-driver'
import { seedProject } from '@yaac/test-utils/project-fixture'
import type { WorkspaceDriver } from '#drivers/contract'
import { ServerError } from '@yaac/shared/errors'
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
    expect(row).toMatchObject({ kind: 'create', tool: 'claude', prompt: 'go', model: 'claude-opus-5-5', modelName: 'Opus 5.5' })
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

  // A failed create rolls back. Its prompt survives as a draft, updating
  // the one it came from, only for a caller that asked; the error is the
  // create's own, so its code stands.
  it('keeps a failed create\'s prompt as a draft only when asked, leaving no workspace', async () => {
    // One error for every launch, as concurrent creates sharing a build or
    // install see; neither create may change what the other reports.
    const shared = new ServerError('VALIDATION', 'pod never became ready')
    installDriver({ awaitReady: () => Promise.reject(shared) })
    const draft = await saveDraftWorkspace(local, PROJ, { prompt: 'old', tool: 'claude', mode: 'tui', permissionMode: 'plan' })
    const start = (workspaceId: string, onFailure: boolean): Promise<unknown> => startWorkspace(local, {
      projectId: PROJ,
      workspaceId,
      tool: 'codex',
      permissionMode: 'accept-edits',
      mode: 'tui',
      prompt: 'fix the build',
      title: 'Build',
      rememberDefaults: false,
      claimSpare: false,
      draft: { id: draft.id, ...(onFailure ? { onFailure } : {}) },
    }, () => {})

    await expect(start('wt-plain', false)).rejects.toMatchObject({ message: 'pod never became ready' })
    expect(await listDraftWorkspaces()).toEqual([expect.objectContaining({ id: draft.id, prompt: 'old' })])

    await expect(start('wt-fail', true)).rejects.toMatchObject({
      code: 'VALIDATION', message: 'pod never became ready; its prompt is kept as a draft',
    })
    expect(await listDraftWorkspaces()).toEqual([expect.objectContaining({
      id: draft.id, prompt: 'fix the build', title: 'Build', tool: 'codex', permissionMode: 'accept-edits',
    })])
    expect(shared.message).toBe('pod never became ready')
    await vi.waitFor(async () => expect(await getWorkspaceRow(PROJ, 'wt-fail')).toBeUndefined(), { timeout: 30_000 })
  })
})
