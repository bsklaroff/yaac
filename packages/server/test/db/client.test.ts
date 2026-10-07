/**
 * `openDb` and `closeDb`, against a real PGlite in a temp data dir with the
 * checked-in migrations, so the data-dir path builder, single-flight open
 * and dangling-handle close are covered by the dir switches below. `getDb`
 * is used only to inspect what a call opened; `preferences` is the sample
 * table.
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
import { BUILT_IN_USER_ID } from '#db/user-store'

// Other unit tests share one in-memory PGlite (YAAC_TEST_SHARED_DB) for
// speed. This file opts out because the on-disk per-dir handle is what it
// tests (0700 dir, distinct handle after a dir switch, checkpoint surviving
// a reopen).
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
    // Checked before any getDb(): the handle opens lazily, so this pins that
    // openDb itself opened and migrated.
    const stat = await fs.stat(path.join(getDataDir(), 'server-local', 'db'))
    expect(stat.isDirectory()).toBe(true)
    expect(stat.mode & 0o777).toBe(0o700)
    const db = await getDb()
    await db.insert(preferences).values({ owner: BUILT_IN_USER_ID, key: 'k', value: 'v' })
    expect(await db.select({ key: preferences.key, value: preferences.value }).from(preferences)).toEqual([{ key: 'k', value: 'v' }])
  })

  it('caches the handle while the data dir is stable', async () => {
    await freshDataDir()
    await openDb()
    await openDb()
    expect(await getDb()).toBe(await getDb())
  })

  // Data-moving migrations, which nothing else catches since every other
  // test starts from an empty migrated database. `seedBefore` migrates up to
  // (not including) `name`, runs `seed`, then migrates the rest.
  const migrations = path.resolve(fileURLToPath(import.meta.url), '../../../drizzle')
  async function seedBefore(
    name: string,
    seed: string,
  ): Promise<ReturnType<typeof drizzle>> {
    const all = (await fs.readdir(migrations)).filter((d) => /^\d{14}_/.test(d)).sort()
    const target = all.findIndex((d) => d.endsWith(`_${name}`))
    expect(target).toBeGreaterThan(0)
    const before = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-migrations-'))
    dirs.push(before)
    for (const d of all.slice(0, target)) {
      await fs.cp(path.join(migrations, d), path.join(before, d), { recursive: true })
    }
    const db = drizzle({ connection: { dataDir: 'memory://' } })
    await migrate(db, { migrationsFolder: before })
    await db.$client.exec(seed)
    await migrate(db, { migrationsFolder: migrations })
    return db
  }

  // The project's single remembered posture and the global default tool
  // become per-agent create memory.
  it('carries the old create memory into per-agent rows', async () => {
    const db = await seedBefore('per_project_create_defaults', `
        INSERT INTO projects (slug, remote_url, added_at, last_permission_mode)
          VALUES ('p', 'git@h:o/p.git', 'now', 'auto'), ('q', 'git@h:o/q.git', 'now', NULL);
        INSERT INTO preferences (key, value) VALUES ('default_tool', 'codex');
      `)
    try {
      const memory = await db.$client.query<{ name: string; tool: string; permission_mode: string }>(
        `SELECT p.name, t.tool, t.permission_mode FROM project_tool_defaults t
          JOIN projects p ON p.id = t.project_id ORDER BY p.name, t.tool`,
      )
      // `auto` reaches the tools that have it — never opencode (no reviewer
      // posture) and never pi, whose only posture says nothing about taste.
      expect(memory.rows).toEqual([
        { name: 'p', tool: 'claude', permission_mode: 'auto' },
        { name: 'p', tool: 'codex', permission_mode: 'auto' },
      ])
      const lastTools = await db.$client.query<{ name: string; last_tool: string | null }>(
        'SELECT name, last_tool FROM projects ORDER BY name',
      )
      expect(lastTools.rows).toEqual([
        { name: 'p', last_tool: 'codex' },
        { name: 'q', last_tool: 'codex' },
      ])
      const prefs = await db.$client.query('SELECT key FROM preferences')
      expect(prefs.rows).toEqual([])
    } finally {
      await db.$client.close()
    }
  })

  // A draft's title was the generated one; it moves aside for the user's. A
  // queued entry launched into its nearest parent workspace's group, and now
  // stores it — walked up a chain, and none when that workspace is ungrouped,
  // has no row, or the chain dangles or loops.
  it('moves draft titles aside and files queued entries in their parent\'s group', async () => {
    const entry = (id: string, parent: string): string =>
      `('${id}', 'p', ${parent}, 'go', 'claude', 'opus', 'tui', 'bypass', 'main')`
    const uuid = (n: number): string => `00000000-0000-4000-8000-00000000000${n}`
    const db = await seedBefore('queued_and_draft_titles_and_groups', `
      INSERT INTO projects (slug, remote_url, added_at) VALUES ('p', 'git@h:o/p.git', 'now');
      INSERT INTO draft_worktrees (id, project_slug, prompt, title, tool, mode, permission_mode) VALUES
        ('${uuid(1)}', 'p', 'x', 'Gen one', 'claude', 'tui', 'bypass'),
        ('${uuid(2)}', 'p', 'y', NULL, 'claude', 'tui', 'bypass');
      INSERT INTO worktrees (project_slug, worktree_id, group_id) VALUES ('p', 'w1', 'g1'), ('p', 'w2', NULL);
      INSERT INTO queued_worktrees
        (id, project_slug, parent_worktree_id, parent_queued_id, prompt, tool, model, mode, permission_mode, branch)
      VALUES
        ${entry(uuid(1), `'w1', NULL`)}, ${entry(uuid(2), `NULL, '${uuid(1)}'`)},
        ${entry(uuid(3), `NULL, '${uuid(2)}'`)}, ${entry(uuid(4), `'w2', NULL`)},
        ${entry(uuid(5), `'w-missing', NULL`)}, ${entry(uuid(6), `NULL, '${uuid(9)}'`)},
        ${entry(uuid(7), `NULL, '${uuid(8)}'`)}, ${entry(uuid(8), `NULL, '${uuid(7)}'`)};
    `)
    try {
      const drafts = await db.$client.query<{ title: string | null; generated_title: string | null }>(
        'SELECT title, generated_title FROM draft_workspaces ORDER BY id',
      )
      expect(drafts.rows).toEqual([
        { title: null, generated_title: 'Gen one' },
        { title: null, generated_title: null },
      ])
      const queued = await db.$client.query<{ group_id: string | null }>(
        'SELECT group_id FROM queued_workspaces ORDER BY id',
      )
      expect(queued.rows.map((r) => r.group_id)).toEqual(['g1', 'g1', 'g1', null, null, null, null, null])
    } finally {
      await db.$client.close()
    }
  })

  // Every project reference moves from the slug to the project's id, the
  // slug stays on as the display name, and a row naming no project goes.
  it('re-keys project references by id and keeps the slug as the name', async () => {
    const id = '11111111-2222-4333-8444-555555555555'
    const db = await seedBefore('key_projects_by_id', `
      INSERT INTO projects (id, slug, remote_url, added_at) VALUES ('${id}', 'demo', 'git@h:o/demo.git', 'now');
      INSERT INTO workspaces (project_slug, workspace_id) VALUES ('demo', 'w1'), ('gone', 'w2');
      INSERT INTO project_env_vars (project_slug, name, value) VALUES ('demo', 'A', 'x'), ('gone', 'B', 'y');
      INSERT INTO workspace_groups (project_slug, group_id, name) VALUES ('demo', 'g1', 'G'), ('gone', 'g2', 'H');
    `)
    try {
      const projects = await db.$client.query('SELECT id, name FROM projects')
      expect(projects.rows).toEqual([{ id, name: 'demo' }])
      const keys = async (table: string, key: string): Promise<unknown[]> =>
        (await db.$client.query(`SELECT project_id, ${key} AS key FROM ${table}`)).rows
      expect(await keys('workspaces', 'workspace_id')).toEqual([{ project_id: id, key: 'w1' }])
      expect(await keys('project_env_vars', 'name')).toEqual([{ project_id: id, key: 'A' }])
      expect(await keys('workspace_groups', 'group_id')).toEqual([{ project_id: id, key: 'g1' }])
    } finally {
      await db.$client.close()
    }
  })

  it('reopens against the new dir when setDataDir changes it', async () => {
    await freshDataDir()
    await openDb()
    const first = await getDb()
    await first.insert(preferences).values({ owner: BUILT_IN_USER_ID, key: 'k', value: 'v' })
    await freshDataDir() // createTempDataDir calls setDataDir
    await openDb()
    const second = await getDb()
    expect(second).not.toBe(first)
    expect(await second.select({ key: preferences.key, value: preferences.value }).from(preferences)).toEqual([])
  })
})

describe('closeDb', () => {
  it('checkpoints so the data survives a reopen (re-migrate is a no-op)', async () => {
    await freshDataDir()
    await openDb()
    const db = await getDb()
    await db.insert(preferences).values({ owner: BUILT_IN_USER_ID, key: 'k', value: 'v' })
    await closeDb()
    await openDb()
    const reopened = await getDb()
    expect(reopened).not.toBe(db)
    expect(await reopened.select({ key: preferences.key, value: preferences.value }).from(preferences)).toEqual([{ key: 'k', value: 'v' }])
  })

  it('is idempotent and safe with nothing open', async () => {
    await closeDb()
    await freshDataDir()
    await openDb()
    await closeDb()
    await closeDb()
  })
})
