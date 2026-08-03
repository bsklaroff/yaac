/**
 * The database handle's lifecycle — `getDb`, `closeDb`.
 *
 * Nothing under platform/db is mocked here: a real PGlite instance is opened
 * in a temp data dir and the checked-in migrations run against it, so the
 * private data-dir path builder, the single-flighted open and the dangling
 * -handle close are covered by the dir switches these tests drive rather
 * than by tests of their own. `preferences` is the sample table.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir, getDataDir } from '@yaac/test-utils/setup'
import { getDb, closeDb, preferences } from '#platform/db'

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

describe('getDb', () => {
  it('creates <dataDir>/db at 0700, migrates, and answers queries', async () => {
    await freshDataDir()
    const db = await getDb()
    const stat = await fs.stat(path.join(getDataDir(), 'db'))
    expect(stat.isDirectory()).toBe(true)
    expect(stat.mode & 0o777).toBe(0o700)
    await db.insert(preferences).values({ key: 'k', value: 'v' })
    expect(await db.select().from(preferences)).toEqual([{ key: 'k', value: 'v' }])
  })

  it('caches the handle while the data dir is stable', async () => {
    await freshDataDir()
    expect(await getDb()).toBe(await getDb())
  })

  it('reopens against the new dir when setDataDir changes it', async () => {
    await freshDataDir()
    const first = await getDb()
    await first.insert(preferences).values({ key: 'k', value: 'v' })
    await freshDataDir() // createTempDataDir calls setDataDir
    const second = await getDb()
    expect(second).not.toBe(first)
    expect(await second.select().from(preferences)).toEqual([])
  })
})

describe('closeDb', () => {
  it('checkpoints so the data survives a reopen (re-migrate is a no-op)', async () => {
    await freshDataDir()
    const db = await getDb()
    await db.insert(preferences).values({ key: 'k', value: 'v' })
    await closeDb()
    const reopened = await getDb()
    expect(reopened).not.toBe(db)
    expect(await reopened.select().from(preferences)).toEqual([{ key: 'k', value: 'v' }])
  })

  it('is idempotent and safe with nothing open', async () => {
    await closeDb()
    await freshDataDir()
    await getDb()
    await closeDb()
    await closeDb()
  })
})
