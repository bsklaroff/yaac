import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { handleFixture, installFakeWorkspaceDriver, resetWorkspaceDriver } from '#test/support/fake-driver'
import type { RuntimeHandle } from '#drivers/contract'

import { removeProject } from '#domain/workspaces'
import { listWorkspaceRows, recordWorkspaceCreated } from '#db/workspace-store'
import { listProjectRows } from '#db/project-store'
import { listProjectEnvVars, upsertProjectEnvVar } from '#db/project-env-store'
import { closeDb } from '#db/client'
import { nodeLocalProjectPath, projectDir } from '@yaac/shared/project-paths'
import { getProjectsDir } from '@yaac/shared/paths'
import { DEMO_PROJECT_ID, recordTestProject } from '@yaac/test-utils/project-fixture'
import { BUILT_IN_USER_ID } from '#db'

/** The caller of every user-caused write here. */
const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const

const KEEPER = '6cc61f49-c2ae-433a-8d09-1f22d7868752'
const NOPE = '4101bef8-794f-4d98-8e95-dfb54850c68b'

/** The projects whose substrate the purge dropped, and the rows that
 *  existed at the time, so a test can check the purge runs before the rows
 *  are deleted. */
const purged: string[] = []
let rowsAtPurge: string[] = []
/** The project's running workspaces, and the ones torn down. */
const mockList = vi.fn<(projectId?: string) => Promise<RuntimeHandle[]>>()
const mockDeregister = vi.fn<(workspaceId: string) => Promise<void>>()

let tmpDir: string

function installDriver(destroySubstrate?: () => Promise<void>): void {
  installFakeWorkspaceDriver({
    list: mockList,
    deregisterWorkspace: mockDeregister,
    destroyProjectSubstrate: async (project) => {
      purged.push(project)
      rowsAtPurge = (await listWorkspaceRows()).map((r) => r.workspaceId)
      await destroySubstrate?.()
    },
  })
}

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  purged.length = 0
  rowsAtPurge = []
  mockList.mockReset().mockResolvedValue([])
  mockDeregister.mockReset().mockResolvedValue(undefined)
  installDriver()
})

/** A running workspace of `projectId`. */
const running = (projectId: string, workspaceId: string): RuntimeHandle =>
  handleFixture({ jobName: `yaac-${workspaceId}`, workspaceId, projectId })

afterEach(async () => {
  await fs.chmod(getProjectsDir(), 0o755).catch(() => {})
  resetWorkspaceDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('removeProject', () => {
  it('tears its workspaces down and erases its bytes, then drops only this project’s rows', async () => {
    await recordTestProject(DEMO_PROJECT_ID)
    await recordTestProject(KEEPER)
    for (const projectId of [DEMO_PROJECT_ID, KEEPER]) {
      await fs.mkdir(path.join(nodeLocalProjectPath(projectId), 'repo'), { recursive: true })
    }
    mockList.mockResolvedValue([running(DEMO_PROJECT_ID, 'a'), running(DEMO_PROJECT_ID, 'b')])
    // One teardown failing does not stop the rest.
    mockDeregister.mockRejectedValueOnce(new Error('exec failed'))
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'a' })
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'b' })
    await recordWorkspaceCreated({ projectId: KEEPER, workspaceId: 'c' })
    await upsertProjectEnvVar(DEMO_PROJECT_ID, { name: 'MINE', value: 'x', secret: false })
    await upsertProjectEnvVar(KEEPER, { name: 'THEIRS', value: 'y', secret: false })

    await removeProject(local, DEMO_PROJECT_ID)

    // First argument only: the fake records a trailing undefined opts.
    expect(mockList.mock.calls.map(([projectId]) => projectId)).toEqual([DEMO_PROJECT_ID])
    expect(mockDeregister.mock.calls).toEqual([['a'], ['b']])
    expect(purged).toEqual([DEMO_PROJECT_ID])
    await expect(fs.access(projectDir(DEMO_PROJECT_ID))).rejects.toThrow()
    await expect(fs.access(projectDir(KEEPER))).resolves.toBeUndefined()
    // The node-local tree is the driver's to remove; it may live on another
    // machine.
    await expect(fs.access(nodeLocalProjectPath(DEMO_PROJECT_ID))).resolves.toBeUndefined()
    // Bytes go first. If rows went first and the purge then failed, the
    // leftover clone could not be listed, removed or re-added.
    expect(rowsAtPurge.sort()).toEqual(['a', 'b', 'c'])
    // Only this project's rows go.
    expect((await listWorkspaceRows()).map((r) => r.workspaceId)).toEqual(['c'])
    expect((await listProjectRows()).map((p) => p.id)).toEqual([KEEPER])
    // Its env vars go too; some are secrets, so this cannot wait for the
    // reaper.
    expect(await listProjectEnvVars(DEMO_PROJECT_ID)).toEqual([])
    expect((await listProjectEnvVars(KEEPER)).map((v) => v.name)).toEqual(['THEIRS'])
  })

  // Best effort: an unreachable runtime must not keep the directories
  // around. The orphan GCs sweep whatever is left.
  it('still erases the dirs when the runtime is unreachable', async () => {
    await recordTestProject(DEMO_PROJECT_ID)
    mockList.mockRejectedValue(new Error('connection refused'))
    installDriver(() => Promise.reject(new Error('connection refused')))

    await removeProject(local, DEMO_PROJECT_ID)

    expect(mockDeregister).not.toHaveBeenCalled()
    await expect(fs.access(projectDir(DEMO_PROJECT_ID))).rejects.toThrow()
    expect(await listProjectRows()).toEqual([])
  })

  it('throws NOT_FOUND for an unknown project, touching nothing', async () => {
    await expect(removeProject(local, NOPE)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(purged).toEqual([])
  })

  // A failed purge keeps the rows so `project remove` can be retried.
  it('keeps the rows when the purge cannot erase the bytes', async () => {
    await recordTestProject(DEMO_PROJECT_ID)
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'a' })
    // The project tree cannot be removed from a read-only parent.
    await fs.chmod(getProjectsDir(), 0o555)

    await expect(removeProject(local, DEMO_PROJECT_ID)).rejects.toThrow(/EACCES/)

    expect((await listWorkspaceRows()).map((r) => r.workspaceId)).toEqual(['a'])
    expect((await listProjectRows()).map((p) => p.id)).toEqual([DEMO_PROJECT_ID])
  })

  it('is idempotent once the rows are gone', async () => {
    await recordTestProject(DEMO_PROJECT_ID)
    await removeProject(local, DEMO_PROJECT_ID)
    await expect(removeProject(local, DEMO_PROJECT_ID)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(purged).toEqual([DEMO_PROJECT_ID])
  })
})
