import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { installFakeWorkspaceDriver, resetWorkspaceDriver } from '@yaac/test-utils/fake-driver'

import { removeProject } from '#domain/workspaces'
import { listWorkspaceRows, recordWorkspaceCreated } from '#db/workspace-store'
import { listProjectRows } from '#db/project-store'
import { listProjectEnvVars, upsertProjectEnvVar } from '#db/project-env-store'
import { closeDb } from '#db/client'
import { projectDir } from '@yaac/shared/project-paths'
import { getProjectsDir } from '@yaac/shared/paths'
import { DEMO_PROJECT_ID, recordTestProject } from '@yaac/test-utils/project-fixture'

const KEEPER = '6cc61f49-c2ae-433a-8d09-1f22d7868752'
const NOPE = '4101bef8-794f-4d98-8e95-dfb54850c68b'

/** The projects whose substrate the purge dropped, and the rows that
 *  existed at the time, so a test can check the purge runs before the rows
 *  are deleted. */
const purged: string[] = []
let rowsAtPurge: string[] = []

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  purged.length = 0
  rowsAtPurge = []
  installFakeWorkspaceDriver({
    destroyProjectSubstrate: async (project) => {
      purged.push(project)
      rowsAtPurge = (await listWorkspaceRows()).map((r) => r.workspaceId)
    },
  })
})

afterEach(async () => {
  await fs.chmod(getProjectsDir(), 0o755).catch(() => {})
  resetWorkspaceDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('removeProject', () => {
  it('erases the bytes, then drops only this project’s rows', async () => {
    await recordTestProject(DEMO_PROJECT_ID)
    await recordTestProject(KEEPER)
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'a' })
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'b' })
    await recordWorkspaceCreated({ projectId: KEEPER, workspaceId: 'c' })
    await upsertProjectEnvVar(DEMO_PROJECT_ID, { name: 'MINE', value: 'x', secret: false })
    await upsertProjectEnvVar(KEEPER, { name: 'THEIRS', value: 'y', secret: false })

    await removeProject(DEMO_PROJECT_ID)

    expect(purged).toEqual([DEMO_PROJECT_ID])
    await expect(fs.access(projectDir(DEMO_PROJECT_ID))).rejects.toThrow()
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

  it('throws NOT_FOUND for an unknown project, touching nothing', async () => {
    await expect(removeProject(NOPE)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(purged).toEqual([])
  })

  // A failed purge keeps the rows so `project remove` can be retried.
  it('keeps the rows when the purge cannot erase the bytes', async () => {
    await recordTestProject(DEMO_PROJECT_ID)
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'a' })
    // The project tree cannot be removed from a read-only parent.
    await fs.chmod(getProjectsDir(), 0o555)

    await expect(removeProject(DEMO_PROJECT_ID)).rejects.toThrow(/EACCES/)

    expect((await listWorkspaceRows()).map((r) => r.workspaceId)).toEqual(['a'])
    expect((await listProjectRows()).map((p) => p.id)).toEqual([DEMO_PROJECT_ID])
  })

  it('is idempotent once the rows are gone', async () => {
    await recordTestProject(DEMO_PROJECT_ID)
    await removeProject(DEMO_PROJECT_ID)
    await expect(removeProject(DEMO_PROJECT_ID)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(purged).toEqual([DEMO_PROJECT_ID])
  })
})
