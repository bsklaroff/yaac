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
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
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
    const stat = await fs.stat(path.join(getDataDir(), 'server-local', 'db'))
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

  // The one migration that moves data rather than only reshaping it: the
  // project's single remembered posture and the global default tool become
  // per-agent create memory. Nothing else can catch it going wrong — every
  // other test starts from a database migrated from empty.
  it('carries the old create memory into per-agent rows', async () => {
    const migrations = path.resolve(fileURLToPath(import.meta.url), '../../../drizzle')
    const all = (await fs.readdir(migrations)).filter((d) => /^\d{14}_/.test(d)).sort()
    const target = all.findIndex((d) => d.endsWith('_per_project_create_defaults'))
    expect(target).toBeGreaterThan(0)
    const before = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-migrations-'))
    dirs.push(before)
    for (const d of all.slice(0, target)) {
      await fs.cp(path.join(migrations, d), path.join(before, d), { recursive: true })
    }

    const db = drizzle({ connection: { dataDir: 'memory://' } })
    try {
      await migrate(db, { migrationsFolder: before })
      await db.$client.exec(`
        INSERT INTO projects (slug, remote_url, added_at, last_permission_mode)
          VALUES ('p', 'git@h:o/p.git', 'now', 'auto'), ('q', 'git@h:o/q.git', 'now', NULL);
        INSERT INTO preferences (key, value) VALUES ('default_tool', 'codex');
      `)
      await migrate(db, { migrationsFolder: migrations })

      const memory = await db.$client.query<{ project_slug: string; tool: string; permission_mode: string }>(
        'SELECT project_slug, tool, permission_mode FROM project_tool_defaults ORDER BY project_slug, tool',
      )
      // `auto` reaches the tools that have it — never opencode (no reviewer
      // posture) and never pi, whose only posture says nothing about taste.
      expect(memory.rows).toEqual([
        { project_slug: 'p', tool: 'claude', permission_mode: 'auto' },
        { project_slug: 'p', tool: 'codex', permission_mode: 'auto' },
      ])
      const lastTools = await db.$client.query<{ slug: string; last_tool: string | null }>(
        'SELECT slug, last_tool FROM projects ORDER BY slug',
      )
      expect(lastTools.rows).toEqual([
        { slug: 'p', last_tool: 'codex' },
        { slug: 'q', last_tool: 'codex' },
      ])
      const prefs = await db.$client.query('SELECT key FROM preferences')
      expect(prefs.rows).toEqual([])
    } finally {
      await db.$client.close()
    }
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
