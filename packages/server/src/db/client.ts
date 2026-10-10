import fs from 'node:fs/promises'
import path from 'node:path'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import type { PGlite } from '@electric-sql/pglite'
import { env, testEnv } from '@yaac/shared/env'
import { PACKAGE_ROOT, serverLocalPath } from '@yaac/shared/paths'
import { forgetSecretConfig } from './secret-key'
import { BUILT_IN_USER_ID, forgetSeenUsers } from './user-store'

/**
 * The server's on-disk PGlite database (embedded Postgres). `getDb` stays off
 * the barrel so other layers can't build their own queries; they get only
 * `openDb`/`closeDb` and the row functions.
 *
 * PGlite is single-process, so only the server process may open it. The
 * proxy, auth-daemon and CLI share the data dir but never touch
 * `<dataDir>/db`, which is why `dbDir()` is private here. The server lock is
 * the single-writer guard: the server opens the DB only after `acquireLock`
 * succeeds.
 */

export type Db = PgliteDatabase & { $client: PGlite }

/** The checked-in migration SQL: under packages/server in dev; the build
 *  copies it to dist/drizzle. */
const MIGRATIONS_DIR = env.bundled
  ? path.join(PACKAGE_ROOT, 'drizzle')
  : path.join(PACKAGE_ROOT, 'packages', 'server', 'drizzle')

let cached: { dir: string; promise: Promise<Db> } | null = null

/**
 * Shared-instance mode, for unit tests only (`testEnv.sharedTestDb`). One
 * in-memory PGlite serves every data dir; switching dirs truncates the
 * tables instead of opening a new instance. test/db/client.test.ts opts out
 * to test the real on-disk path.
 */
let sharedDb: Promise<Db> | null = null
let sharedDir: string | null = null

async function openSharedDb(): Promise<Db> {
  const db = drizzle({ connection: { dataDir: 'memory://' } })
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR })
  return db
}

/**
 * Empty every table in the `public` schema, so the next data dir starts as
 * clean as a freshly migrated one: empty, bar the built-in user the
 * migration inserts. Tables come from the catalog, so ones added by later
 * migrations are covered. `RESTART IDENTITY` resets sequences; `CASCADE` is
 * needed for referenced tables. drizzle's migration bookkeeping lives in the
 * `drizzle` schema and is kept.
 */
async function wipeSharedDb(db: Db): Promise<void> {
  const { rows } = await db.$client.query<{ tablename: string }>(
    'SELECT tablename FROM pg_tables WHERE schemaname = \'public\'',
  )
  if (rows.length === 0) return
  const list = rows.map((r) => `"${r.tablename}"`).join(', ')
  await db.$client.exec(`TRUNCATE ${list} RESTART IDENTITY CASCADE`)
  await db.$client.query('INSERT INTO users (id, name) VALUES ($1, $2)', [BUILT_IN_USER_ID, 'local'])
}

function getSharedDb(dir: string): Promise<Db> {
  if (cached?.dir === dir) return cached.promise
  const promise = (sharedDb ??= openSharedDb()).then(async (db) => {
    // Wipe only on a change of dir: after closeDb(), reopening the same dir
    // must still see its data, as with the on-disk handle.
    if (sharedDir !== dir) {
      await wipeSharedDb(db)
      sharedDir = dir
    }
    return db
  })
  cached = { dir, promise }
  return promise
}

/** Always server-local: PGlite must never live on a network filesystem. */
function dbDir(): string {
  return serverLocalPath('db')
}

async function openHandle(dir: string, prev: Promise<Db> | null): Promise<Db> {
  // Close a previous handle left by a mid-process data dir change (tests
  // only), or it would leak a postgres instance.
  if (prev) await prev.then((db) => db.$client.close()).catch(() => undefined)
  // 0700 to protect the encrypted secrets inside. chmod after mkdir so an
  // existing dir or the umask can't leave it wider.
  await fs.mkdir(dir, { recursive: true })
  await fs.chmod(dir, 0o700)
  const db = drizzle({ connection: { dataDir: dir } })
  try {
    await refuseUnknownMigrations(db, dir)
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR })
  } catch (err) {
    await db.$client.close().catch(() => undefined)
    throw err
  }
  return db
}

/** Why `openDb` refused the database: it records a migration this build
 *  does not ship. The server stays up answering `/health` with the message
 *  rather than exiting. */
export class MigrationRefusal extends Error {}

/**
 * Refuse a database that records a migration this build does not ship.
 * drizzle applies only the migrations missing from its table, so it would
 * open such a database silently, and this server would then read and write a
 * schema it does not know. A fresh database has no table yet and passes.
 *
 * Usually a newer yaac migrated it, but the same check fires when this
 * install lost some of its own migration files (a server started while a
 * build was copying them). Names cannot tell the two apart, since migrations
 * do not land in timestamp order, so the message names both.
 */
async function refuseUnknownMigrations(db: Db, dir: string): Promise<void> {
  const { rows: [table] } = await db.$client.query<{ name: string | null }>(
    'SELECT to_regclass(\'drizzle.__drizzle_migrations\') AS name',
  )
  if (!table?.name) return
  const { rows } = await db.$client.query<{ name: string | null }>(
    'SELECT name FROM drizzle.__drizzle_migrations',
  )
  const known = new Set(await fs.readdir(MIGRATIONS_DIR))
  const unknown = rows.flatMap((r) => (r.name && !known.has(r.name) ? [r.name] : []))
  if (unknown.length === 0) return
  throw new MigrationRefusal(
    `the database at ${dir} records migrations missing from ${MIGRATIONS_DIR} (${unknown.join(', ')}). `
    + 'Either a newer yaac migrated it, so upgrade yaac, or this install\'s migration files are '
    + 'incomplete, so rebuild or reinstall it',
  )
}

/**
 * Open the database and run pending migrations. Called by the composition
 * root once the server lock is held. Returns nothing, since the handle stays
 * private to this folder.
 */
export async function openDb(): Promise<void> {
  await getDb()
}

/**
 * Lazy handle for the current data dir, used only by the row functions in
 * this folder. Concurrent callers share one open; a failed open clears the
 * cache so the next caller retries.
 */
export function getDb(): Promise<Db> {
  const dir = dbDir()
  if (cached?.dir !== dir) forgetSeenUsers()
  if (testEnv.sharedTestDb) return getSharedDb(dir)
  if (cached?.dir !== dir) {
    const promise = openHandle(dir, cached?.promise ?? null)
    cached = { dir, promise }
    promise.catch(() => {
      if (cached?.promise === promise) cached = null
    })
  }
  return cached.promise
}

/** Close the handle so PGlite checkpoints cleanly (dev-watch restarts, test
 *  teardown before temp-dir removal). Idempotent. */
export async function closeDb(): Promise<void> {
  const prev = cached
  cached = null
  // The encryption key and seen users are cached per data dir too, so drop
  // them together.
  forgetSecretConfig()
  forgetSeenUsers()
  // The shared test instance must stay open for the next test; dropping the
  // cache is enough.
  if (testEnv.sharedTestDb) return
  if (!prev) return
  try {
    const db = await prev.promise
    await db.$client.close()
  } catch {
    // Open failed, so there is nothing to close.
  }
}
