/**
 * The database's open/close pair — `openDb`, `closeDb`.
 *
 * Nothing in the handle is mocked here: a real PGlite instance is opened
 * in a temp data dir and the checked-in migrations run against it, so the
 * private data-dir path builder, the single-flighted open and the dangling
 * -handle close are covered by the dir switches these tests drive rather
 * than by tests of their own. `getDb` is the internal accessor the row
 * functions use; it appears below only to look at what a call opened.
 * `preferences` is the sample table.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir, getDataDir } from '@yaac/test-utils/setup'
import { openDb, getDb, closeDb } from '#db/client'
import { preferences } from '#db/schema'

// The rest of the unit suite borrows one shared in-memory PGlite (the unit
// setup file sets YAAC_TEST_SHARED_DB) because booting one per test dominates
// its runtime. This file is the exception: the on-disk instance-per-dir
// handle is the behavior under test — the 0700 dir, the distinct handle after
// a dir switch, the checkpoint that survives a reopen — none of which the
// shared handle has. Opt out so these assertions describe the real thing.
vi.stubEnv('YAAC_TEST_SHARED_DB', '')

const dirs: string[] = []

async function freshDataDir(): Promise<string> {
  const dir = await createTempDataDir()
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await closeDb()
  while (dirs.length > 0) await cleanupTempDir(dirs.pop() as string)
})

describe('openDb', () => {
  it('creates <dataDir>/db at 0700, migrates, and answers queries', async () => {
    await freshDataDir()
    await openDb()
    // Before any getDb() — the handle opens lazily, so asserting the dir
    // only after one would hold for a no-op openDb too. What this pins is
    // that the call itself opened and migrated.
    const stat = await fs.stat(path.join(getDataDir(), 'db'))
    expect(stat.isDirectory()).toBe(true)
    expect(stat.mode & 0o777).toBe(0o700)
    const db = await getDb()
    await db.insert(preferences).values({ key: 'k', value: 'v' })
    expect(await db.select().from(preferences)).toEqual([{ key: 'k', value: 'v' }])
  })

  it('caches the handle while the data dir is stable', async () => {
    await freshDataDir()
    await openDb()
    await openDb()
    expect(await getDb()).toBe(await getDb())
  })

  it('reopens against the new dir when setDataDir changes it', async () => {
    await freshDataDir()
    await openDb()
    const first = await getDb()
    await first.insert(preferences).values({ key: 'k', value: 'v' })
    await freshDataDir() // createTempDataDir calls setDataDir
    await openDb()
    const second = await getDb()
    expect(second).not.toBe(first)
    expect(await second.select().from(preferences)).toEqual([])
  })
})

describe('closeDb', () => {
  it('checkpoints so the data survives a reopen (re-migrate is a no-op)', async () => {
    await freshDataDir()
    await openDb()
    const db = await getDb()
    await db.insert(preferences).values({ key: 'k', value: 'v' })
    await closeDb()
    await openDb()
    const reopened = await getDb()
    expect(reopened).not.toBe(db)
    expect(await reopened.select().from(preferences)).toEqual([{ key: 'k', value: 'v' }])
  })

  it('is idempotent and safe with nothing open', async () => {
    await closeDb()
    await freshDataDir()
    await openDb()
    await closeDb()
    await closeDb()
  })
})
