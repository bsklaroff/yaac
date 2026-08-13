import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getProjectsDir } from '@yaac/shared/project-paths'
import { closeDb } from '#db/client'
import {
  deleteProjectRow,
  getProjectLastPermissionMode,
  getProjectRow,
  listProjectRows,
  recordProject,
  recordProjectPermissionMode,
} from '#db/project-store'
import { onWorktreeListChanged, _resetWorktreeListChangedForTests } from '#notify'

describe('recordProject', () => {
  let tmpDir: string
  let pushes: number

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    _resetWorktreeListChangedForTests()
    pushes = 0
    onWorktreeListChanged(() => { pushes += 1 })
  })
  afterEach(async () => {
    _resetWorktreeListChangedForTests()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('records a project and reads it back', async () => {
    await recordProject({ slug: 'app', remoteUrl: 'https://x/app.git', addedAt: '2026-01-01' })

    expect(await getProjectRow('app')).toEqual({
      slug: 'app', remoteUrl: 'https://x/app.git', addedAt: '2026-01-01',
    })
  })

  // Re-adding the same slug is how a re-clone lands; the original addedAt is
  // the project's age and must not be reset by it.
  it('keeps the original addedAt when the same slug is recorded again', async () => {
    await recordProject({ slug: 'app', remoteUrl: 'https://x/app.git', addedAt: '2026-01-01' })
    await recordProject({ slug: 'app', remoteUrl: 'https://y/app.git', addedAt: '2026-06-01' })

    expect(await getProjectRow('app')).toMatchObject({
      remoteUrl: 'https://y/app.git', addedAt: '2026-01-01',
    })
  })

  // The project list is a snapshot input, and this is its only INSERT — so
  // it is where a new project announces itself. Nothing above it pushes:
  // before this, a newly added project reached the sidebar only because a
  // reconcile pass happened to rebuild the snapshot afterwards.
  it('pushes a fresh snapshot', async () => {
    await recordProject({ slug: 'app', remoteUrl: 'https://x/app.git', addedAt: '2026-01-01' })
    expect(pushes).toBe(1)
  })
})

describe('deleteProjectRow', () => {
  let tmpDir: string

  beforeEach(async () => { tmpDir = await createTempDataDir() })
  afterEach(async () => {
    _resetWorktreeListChangedForTests()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('removes the row and pushes a fresh snapshot', async () => {
    await recordProject({ slug: 'app', remoteUrl: 'https://x/app.git', addedAt: '2026-01-01' })
    _resetWorktreeListChangedForTests()
    let pushes = 0
    onWorktreeListChanged(() => { pushes += 1 })

    await deleteProjectRow('app')
    expect(await getProjectRow('app')).toBeUndefined()
    expect(pushes).toBe(1)
  })
})

describe('listProjectRows', () => {
  let tmpDir: string

  beforeEach(async () => { tmpDir = await createTempDataDir() })
  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  const writeProjectDir = async (slug: string, meta: unknown): Promise<void> => {
    const dir = path.join(getProjectsDir(), slug)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify(meta))
  }

  it('is empty on a fresh data dir', async () => {
    expect(await listProjectRows()).toEqual([])
  })

  // The adoption shim: an install that predates the table keeps its projects.
  it('adopts a project.json that has no row', async () => {
    await writeProjectDir('legacy', {
      slug: 'legacy', remoteUrl: 'https://x/legacy.git', addedAt: '2025-12-31',
    })

    expect(await listProjectRows()).toEqual([
      { slug: 'legacy', remoteUrl: 'https://x/legacy.git', addedAt: '2025-12-31' },
    ])
  })

  // Deliberately not one-shot: a durable "already migrated" flag would make a
  // directory that appears later invisible forever.
  it('adopts a directory that appears after the first read', async () => {
    expect(await listProjectRows()).toEqual([])

    await writeProjectDir('late', {
      slug: 'late', remoteUrl: 'https://x/late.git', addedAt: '2026-02-02',
    })

    expect((await listProjectRows()).map((p) => p.slug)).toEqual(['late'])
  })

  // Removal takes the directory with it, so re-adoption cannot resurrect a
  // project the user removed.
  it('does not resurrect a removed project', async () => {
    await writeProjectDir('gone', {
      slug: 'gone', remoteUrl: 'https://x/gone.git', addedAt: '2026-01-01',
    })
    await listProjectRows()

    await fs.rm(path.join(getProjectsDir(), 'gone'), { recursive: true, force: true })
    await deleteProjectRow('gone')

    expect(await listProjectRows()).toEqual([])
  })

  // The dedupe key is the directory name but the recorded slug comes from
  // inside the file, so a mismatch would re-record on every read — and
  // recordProject's upsert would overwrite the real row's remote each time.
  it('refuses a directory whose project.json claims a different slug', async () => {
    await writeProjectDir('app', {
      slug: 'app', remoteUrl: 'https://x/app.git', addedAt: '2026-01-01',
    })
    await writeProjectDir('app-backup', {
      slug: 'app', remoteUrl: 'https://stale/app.git', addedAt: '2020-01-01',
    })

    await listProjectRows()
    await listProjectRows()

    expect(await listProjectRows()).toEqual([
      { slug: 'app', remoteUrl: 'https://x/app.git', addedAt: '2026-01-01' },
    ])
  })

  it('skips a directory with no readable project.json', async () => {
    await fs.mkdir(path.join(getProjectsDir(), 'not-a-project'), { recursive: true })
    await writeProjectDir('malformed', 'not json at all')

    expect(await listProjectRows()).toEqual([])
  })
})

describe('getProjectLastPermissionMode', () => {
  let tmpDir: string
  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    _resetWorktreeListChangedForTests()
  })
  afterEach(async () => {
    _resetWorktreeListChangedForTests()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  // Absent is a real answer, not a default in disguise: it is what tells the
  // create path "nobody has chosen for this project" so it falls through to
  // the per-driver default rather than to somebody else's posture.
  it('answers undefined until a posture has been recorded', async () => {
    await recordProject({ slug: 'p', remoteUrl: 'git@h:o/r.git', addedAt: 'now' })
    expect(await getProjectLastPermissionMode('p')).toBeUndefined()
    expect(await getProjectLastPermissionMode('missing')).toBeUndefined()
  })

  it('round-trips the recorded posture, per project', async () => {
    await recordProject({ slug: 'p', remoteUrl: 'git@h:o/r.git', addedAt: 'now' })
    await recordProject({ slug: 'q', remoteUrl: 'git@h:o/s.git', addedAt: 'now' })
    await recordProjectPermissionMode('p', 'plan')
    expect(await getProjectLastPermissionMode('p')).toBe('plan')
    // A second project is untouched — posture tracks what the code is, so it
    // is remembered per project rather than globally.
    expect(await getProjectLastPermissionMode('q')).toBeUndefined()

    await recordProjectPermissionMode('p', 'manual')
    expect(await getProjectLastPermissionMode('p')).toBe('manual')
    // And it survives a re-record of the project itself, which only rewrites
    // the remote (an `add` of a project that already exists).
    await recordProject({ slug: 'p', remoteUrl: 'git@h:o/moved.git', addedAt: 'now' })
    expect(await getProjectLastPermissionMode('p')).toBe('manual')
  })
})
