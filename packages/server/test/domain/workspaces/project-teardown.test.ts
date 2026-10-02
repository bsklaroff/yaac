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
import type { ProjectRef } from '#drivers/contract'
import { recordTestProject } from '@yaac/test-utils/project-fixture'

/** The projects whose substrate the purge dropped, and the rows that
 *  existed at the time, so a test can check the purge runs before the rows
 *  are deleted. */
const purged: ProjectRef[] = []
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
    await recordTestProject('demo')
    await recordTestProject('keeper')
    await recordWorkspaceCreated({ projectSlug: 'demo', workspaceId: 'a' })
    await recordWorkspaceCreated({ projectSlug: 'demo', workspaceId: 'b' })
    await recordWorkspaceCreated({ projectSlug: 'keeper', workspaceId: 'c' })
    await upsertProjectEnvVar('demo', { name: 'MINE', value: 'x', secret: false })
    await upsertProjectEnvVar('keeper', { name: 'THEIRS', value: 'y', secret: false })
    const demoId = (await listProjectRows()).find((p) => p.slug === 'demo')?.id

    await removeProject('demo')

    // The purge gets the row's id, which names the runtime's objects.
    expect(purged).toEqual([{ slug: 'demo', id: demoId }])
    await expect(fs.access(projectDir('demo'))).rejects.toThrow()
    // Bytes go first. If rows went first and the purge then failed, the
    // leftover clone could not be listed, removed or re-added.
    expect(rowsAtPurge.sort()).toEqual(['a', 'b', 'c'])
    // Only this project's rows go.
    expect((await listWorkspaceRows()).map((r) => r.workspaceId)).toEqual(['c'])
    expect((await listProjectRows()).map((p) => p.slug)).toEqual(['keeper'])
    // Its env vars go too; some are secrets, so this cannot wait for the
    // reaper.
    expect(await listProjectEnvVars('demo')).toEqual([])
    expect((await listProjectEnvVars('keeper')).map((v) => v.name)).toEqual(['THEIRS'])
  })

  it('throws NOT_FOUND for an unknown project, touching nothing', async () => {
    await expect(removeProject('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(purged).toEqual([])
  })

  // A failed purge keeps the rows so `project remove` can be retried.
  it('keeps the rows when the purge cannot erase the bytes', async () => {
    await recordTestProject('demo')
    await recordWorkspaceCreated({ projectSlug: 'demo', workspaceId: 'a' })
    // The project tree cannot be removed from a read-only parent.
    await fs.chmod(getProjectsDir(), 0o555)

    await expect(removeProject('demo')).rejects.toThrow(/EACCES/)

    expect((await listWorkspaceRows()).map((r) => r.workspaceId)).toEqual(['a'])
    expect((await listProjectRows()).map((p) => p.slug)).toEqual(['demo'])
  })

  it('is idempotent once the rows are gone', async () => {
    await recordTestProject('demo')
    await removeProject('demo')
    await expect(removeProject('demo')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(purged.map((p) => p.slug)).toEqual(['demo'])
  })
})
