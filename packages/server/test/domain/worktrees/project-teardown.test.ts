import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

import { removeProject } from '#domain/worktrees'
import { listWorktreeRows, recordWorktreeCreated } from '#records/worktree-store'
import { listProjectRows } from '#records/project-store'
import { closeDb } from '#platform/db/client'
import { projectDir, projectRoots } from '@yaac/shared/project-paths'
import type { ProjectMeta } from '@yaac/shared/types'

vi.mock('#domain/worktrees/project-purge', () => ({ purgeProjectBytes: vi.fn() }))
import { purgeProjectBytes } from '#domain/worktrees/project-purge'

/** What the purge was asked to erase, and what the rows looked like when it
 *  was asked — the ordering across the two is half of what this tests. */
const purged: string[] = []
let rowsAtPurge: string[] = []

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  purged.length = 0
  rowsAtPurge = []
  vi.mocked(purgeProjectBytes).mockReset().mockImplementation(async (slug: string) => {
    purged.push(slug)
    rowsAtPurge = (await listWorktreeRows()).map((r) => r.worktreeId)
    // Erasing the clone is what the real purge does, and it matters here:
    // the adoption shim would otherwise re-adopt the project from the
    // directory the moment its row was deleted.
    for (const root of projectRoots(slug)) {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

afterEach(async () => {
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
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify(meta))
}

describe('removeProject', () => {
  it('erases the bytes, then drops only this project’s rows', async () => {
    await writeProject('demo')
    await writeProject('keeper')
    await recordWorktreeCreated({ projectSlug: 'demo', worktreeId: 'a' })
    await recordWorktreeCreated({ projectSlug: 'demo', worktreeId: 'b' })
    await recordWorktreeCreated({ projectSlug: 'keeper', worktreeId: 'c' })

    await removeProject('demo')

    expect(purged).toEqual(['demo'])
    // The bytes go FIRST: while the project's record exists the project
    // exists, so a purge that then failed must not leave a clone nothing can
    // list, remove, or re-add.
    expect(rowsAtPurge.sort()).toEqual(['a', 'b', 'c'])
    // Only this project's rows go: the deleted listing is row-driven, and
    // the worktrees they point at went with the bytes.
    expect((await listWorktreeRows()).map((r) => r.worktreeId)).toEqual(['c'])
    expect((await listProjectRows()).map((p) => p.slug)).toEqual(['keeper'])
  })

  it('throws NOT_FOUND for an unknown project, touching nothing', async () => {
    await expect(removeProject('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(purged).toEqual([])
  })

  // A purge that throws must not take the rows with it: the project is still
  // there, and `project remove` can be run again.
  it('keeps the rows when the purge cannot erase the bytes', async () => {
    await writeProject('demo')
    await recordWorktreeCreated({ projectSlug: 'demo', worktreeId: 'a' })
    vi.mocked(purgeProjectBytes).mockRejectedValue(new Error('connection refused'))

    await expect(removeProject('demo')).rejects.toThrow('connection refused')

    expect((await listWorktreeRows()).map((r) => r.worktreeId)).toEqual(['a'])
    expect((await listProjectRows()).map((p) => p.slug)).toEqual(['demo'])
  })

  it('is idempotent once the rows are gone', async () => {
    await writeProject('demo')
    await removeProject('demo')
    await expect(removeProject('demo')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(purged).toEqual(['demo'])
  })
})
