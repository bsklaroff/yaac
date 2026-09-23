import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getProjectsDir } from '@yaac/shared/project-paths'
import { closeDb } from '#db/client'
import {
  deleteProjectRow,
  getProjectRow,
  listProjectRows,
  recordProject,
  recordProjectCreate,
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
      slug: 'app', remoteUrl: 'https://x/app.git', addedAt: '2026-01-01', createDefaults: {},
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

  it('removes the row and its create memory, and pushes a fresh snapshot', async () => {
    await recordProject({ slug: 'app', remoteUrl: 'https://x/app.git', addedAt: '2026-01-01' })
    await recordProjectCreate('app', 'codex', { model: 'gpt-6-sol' })
    _resetWorktreeListChangedForTests()
    let pushes = 0
    onWorktreeListChanged(() => { pushes += 1 })

    await deleteProjectRow('app')
    expect(await getProjectRow('app')).toBeUndefined()
    expect(pushes).toBe(1)
    // A project re-added under the same slug starts with no memory rather
    // than inheriting the removed one's.
    await recordProject({ slug: 'app', remoteUrl: 'https://x/app.git', addedAt: '2026-02-01' })
    expect(await getProjectRow('app')).toMatchObject({ createDefaults: {} })
    expect((await getProjectRow('app'))?.lastTool).toBeUndefined()
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
      { slug: 'legacy', remoteUrl: 'https://x/legacy.git', addedAt: '2025-12-31', createDefaults: {} },
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
      { slug: 'app', remoteUrl: 'https://x/app.git', addedAt: '2026-01-01', createDefaults: {} },
    ])
  })

  it('skips a directory with no readable project.json', async () => {
    await fs.mkdir(path.join(getProjectsDir(), 'not-a-project'), { recursive: true })
    await writeProjectDir('malformed', 'not json at all')

    expect(await listProjectRows()).toEqual([])
  })
})

describe('recordProjectCreate', () => {
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

  it('remembers the agent and what it was created with, per agent and per project', async () => {
    await recordProject({ slug: 'p', remoteUrl: 'git@h:o/r.git', addedAt: 'now' })
    await recordProject({ slug: 'q', remoteUrl: 'git@h:o/s.git', addedAt: 'now' })
    let pushes = 0
    onWorktreeListChanged(() => { pushes += 1 })

    await recordProjectCreate('p', 'claude', { model: 'claude-opus-5-5', permissionMode: 'plan', mode: 'acp' })
    await recordProjectCreate('p', 'codex', { model: 'gpt-6-sol' })
    expect(pushes).toBe(2)

    expect(await getProjectRow('p')).toMatchObject({
      lastTool: 'codex',
      createDefaults: {
        claude: { model: 'claude-opus-5-5', permissionMode: 'plan', mode: 'acp' },
        codex: { model: 'gpt-6-sol' },
      },
    })
    // Another project is untouched: the memory is per project.
    const q = await getProjectRow('q')
    expect(q?.lastTool).toBeUndefined()
    expect(q?.createDefaults).toEqual({})
    // And the list read carries the same memory as the point read.
    expect((await listProjectRows()).find((r) => r.slug === 'p')?.createDefaults)
      .toEqual((await getProjectRow('p'))?.createDefaults)
  })

  // A create that took the resolved default for a field names nothing for
  // it, and must not overwrite what a person picked — while the agent itself
  // is always the one this project was last created with.
  it('writes only the fields it is given', async () => {
    await recordProject({ slug: 'p', remoteUrl: 'git@h:o/r.git', addedAt: 'now' })
    await recordProjectCreate('p', 'claude', { model: 'claude-opus-5-5', permissionMode: 'plan' })
    await recordProjectCreate('p', 'claude', { mode: 'acp' })
    await recordProjectCreate('p', 'claude', {})

    expect(await getProjectRow('p')).toMatchObject({
      lastTool: 'claude',
      createDefaults: { claude: { model: 'claude-opus-5-5', permissionMode: 'plan', mode: 'acp' } },
    })

    // It survives a re-record of the project itself, which only rewrites the
    // remote (an `add` of a project that already exists).
    await recordProject({ slug: 'p', remoteUrl: 'git@h:o/moved.git', addedAt: 'now' })
    expect((await getProjectRow('p'))?.lastTool).toBe('claude')
  })
})
