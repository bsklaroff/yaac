import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { installFakeWorkspaceDriver, resetWorkspaceDriver } from '@yaac/test-utils/fake-driver'

import { removeProject } from '#domain/workspaces'
import { listWorkspaceRows, recordWorkspaceCreated } from '#db/workspace-store'
import { listProjectRows, recordProject } from '#db/project-store'
import { listProjectEnvVars, upsertProjectEnvVar } from '#db/project-env-store'
import { closeDb } from '#db/client'
import { nodeLocalProjectPath, projectDir } from '@yaac/shared/project-paths'
import type { ProjectMeta } from '@yaac/shared/types'
import type { ProjectRef } from '#drivers/contract'

vi.mock('#domain/workspaces/project-purge', () => ({ purgeProjectBytes: vi.fn() }))
import { purgeProjectBytes } from '#domain/workspaces/project-purge'

/** What the purge was asked to erase, and what the rows looked like when it
 *  was asked — the ordering across the two is half of what this tests. */
const purged: ProjectRef[] = []
let rowsAtPurge: string[] = []

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  // The teardown tells the runtime to forget the project's proxied secrets:
  // the egress path holds them until told, and a project that no longer
  // exists will never tell it again.
  installFakeWorkspaceDriver()
  purged.length = 0
  rowsAtPurge = []
  vi.mocked(purgeProjectBytes).mockReset().mockImplementation(async (project: ProjectRef) => {
    purged.push(project)
    rowsAtPurge = (await listWorkspaceRows()).map((r) => r.workspaceId)
    // Erasing the clone is what the real purge does.
    for (const root of [projectDir(project.slug), nodeLocalProjectPath(project.id)]) {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

afterEach(async () => {
  resetWorkspaceDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

async function writeProject(slug: string): Promise<void> {
  const dir = projectDir(slug)
  await fs.mkdir(path.join(dir, 'repo'), { recursive: true })
  const meta: ProjectMeta = {
    slug,
    remoteUrl: `https://example.com/${slug}`,
    addedAt: '2026-01-01T00:00:00.000Z',
  }
  await recordProject(meta)
}

describe('removeProject', () => {
  it('erases the bytes, then drops only this project’s rows', async () => {
    await writeProject('demo')
    await writeProject('keeper')
    await recordWorkspaceCreated({ projectSlug: 'demo', workspaceId: 'a' })
    await recordWorkspaceCreated({ projectSlug: 'demo', workspaceId: 'b' })
    await recordWorkspaceCreated({ projectSlug: 'keeper', workspaceId: 'c' })
    await upsertProjectEnvVar('demo', { name: 'MINE', value: 'x', secret: false })
    await upsertProjectEnvVar('keeper', { name: 'THEIRS', value: 'y', secret: false })
    const demoId = (await listProjectRows()).find((p) => p.slug === 'demo')?.id

    await removeProject('demo')

    // The purge is handed the row's id: what the runtime's objects are named by.
    expect(purged).toEqual([{ slug: 'demo', id: demoId }])
    // The bytes go FIRST: while the project's record exists the project
    // exists, so a purge that then failed must not leave a clone nothing can
    // list, remove, or re-add.
    expect(rowsAtPurge.sort()).toEqual(['a', 'b', 'c'])
    // Only this project's rows go: the deleted listing is row-driven, and
    // the workspaces they point at went with the bytes.
    expect((await listWorkspaceRows()).map((r) => r.workspaceId)).toEqual(['c'])
    expect((await listProjectRows()).map((p) => p.slug)).toEqual(['keeper'])
    // Including its environment — the secrets among those are the reason
    // this cannot be left to the reaper.
    expect(await listProjectEnvVars('demo')).toEqual([])
    expect((await listProjectEnvVars('keeper')).map((v) => v.name)).toEqual(['THEIRS'])
  })

  it('throws NOT_FOUND for an unknown project, touching nothing', async () => {
    await expect(removeProject('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(purged).toEqual([])
  })

  // A purge that throws must not take the rows with it: the project is still
  // there, and `project remove` can be run again.
  it('keeps the rows when the purge cannot erase the bytes', async () => {
    await writeProject('demo')
    await recordWorkspaceCreated({ projectSlug: 'demo', workspaceId: 'a' })
    vi.mocked(purgeProjectBytes).mockRejectedValue(new Error('connection refused'))

    await expect(removeProject('demo')).rejects.toThrow('connection refused')

    expect((await listWorkspaceRows()).map((r) => r.workspaceId)).toEqual(['a'])
    expect((await listProjectRows()).map((p) => p.slug)).toEqual(['demo'])
  })

  it('is idempotent once the rows are gone', async () => {
    await writeProject('demo')
    await removeProject('demo')
    await expect(removeProject('demo')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(purged.map((p) => p.slug)).toEqual(['demo'])
  })
})
