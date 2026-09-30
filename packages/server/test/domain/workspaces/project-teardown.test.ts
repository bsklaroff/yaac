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

/** What the purge was asked to erase, and the rows that existed at the time,
 *  so a test can check the purge runs before the rows are deleted. */
const purged: ProjectRef[] = []
let rowsAtPurge: string[] = []

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  // The teardown asks the driver to forget the project's proxied secrets,
  // which the egress path holds until told.
  installFakeWorkspaceDriver()
  purged.length = 0
  rowsAtPurge = []
  vi.mocked(purgeProjectBytes).mockReset().mockImplementation(async (project: ProjectRef) => {
    purged.push(project)
    rowsAtPurge = (await listWorkspaceRows()).map((r) => r.workspaceId)
    // Erase the clone, as the real purge does.
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

    // The purge gets the row's id, which names the runtime's objects.
    expect(purged).toEqual([{ slug: 'demo', id: demoId }])
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
