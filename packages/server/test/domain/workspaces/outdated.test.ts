import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { handleFixture, installFakeWorkspaceDriver, resetWorkspaceDriver } from '#test/support/fake-driver'
import type { RuntimeHandle } from '#drivers/contract'
import { reconcileOutdatedWorkspaces } from '#domain/workspaces'
import { listWorkspaceRows, recordWorkspaceCreated } from '#db/workspace-store'
import { closeDb } from '#db/client'
import { recordTestProject } from '@yaac/test-utils/project-fixture'

/**
 * The upgrade's stop of workspaces on a runtime of an older shape
 * (docs/legacy-compat-shims.md "Workspaces on the gvisor class"): the
 * driver names them, and each is stopped as a user's stop would, its row
 * kept for a restart.
 */

const PROJECT_A = '1a2b3c4d-0000-4000-8000-00000000000a'
const PROJECT_B = '1a2b3c4d-0000-4000-8000-00000000000b'

const mockOutdated = vi.fn<() => Promise<RuntimeHandle[]>>()
const mockDeregister = vi.fn<(workspaceId: string) => Promise<void>>()

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  mockOutdated.mockReset().mockResolvedValue([])
  mockDeregister.mockReset().mockResolvedValue(undefined)
  installFakeWorkspaceDriver({ outdatedWorkspaces: mockOutdated, deregisterWorkspace: mockDeregister })
})

afterEach(async () => {
  resetWorkspaceDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

const handle = (projectId: string, workspaceId: string): RuntimeHandle =>
  handleFixture({ jobName: `yaac-${workspaceId}`, workspaceId, projectId })

const stoppedIds = async (): Promise<string[]> =>
  (await listWorkspaceRows()).filter((r) => r.stoppedAt !== undefined).map((r) => r.workspaceId).sort()

describe('reconcileOutdatedWorkspaces', () => {
  it('stops every workspace the driver names, keeping each row to restart from, and touches nothing when it names none', async () => {
    await recordTestProject(PROJECT_A, { repo: false })
    await recordTestProject(PROJECT_B, { repo: false })
    for (const [projectId, workspaceId] of [[PROJECT_A, 'old-a'], [PROJECT_B, 'old-b'], [PROJECT_A, 'current']]) {
      await recordWorkspaceCreated({ projectId, workspaceId, repos: [] })
    }

    // Nothing outdated: no stop at all.
    await reconcileOutdatedWorkspaces()
    expect(mockDeregister).not.toHaveBeenCalled()

    // Across projects, and one failing to stop does not hold up the next;
    // it is retried on the next pass.
    mockOutdated.mockResolvedValue([handle(PROJECT_A, 'old-a'), handle(PROJECT_B, 'old-b')])
    mockDeregister.mockImplementation((id) => (id === 'old-a' ? Promise.reject(new Error('exec failed')) : Promise.resolve()))
    await reconcileOutdatedWorkspaces()
    expect(mockDeregister.mock.calls.map(([id]) => id).sort()).toEqual(['old-a', 'old-b'])
    expect(await stoppedIds()).toContain('old-b')

    mockDeregister.mockReset().mockResolvedValue(undefined)
    mockOutdated.mockResolvedValue([handle(PROJECT_A, 'old-a')])
    await reconcileOutdatedWorkspaces()
    expect(mockDeregister.mock.calls.map(([id]) => id)).toEqual(['old-a'])
    expect(await stoppedIds()).toEqual(['old-a', 'old-b'])
    // The rows stay, so each restarts from its last checkpoint.
    expect((await listWorkspaceRows()).map((r) => r.workspaceId).sort()).toEqual(['current', 'old-a', 'old-b'])
  })
})
