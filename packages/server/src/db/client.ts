import fs from 'node:fs/promises'
import path from 'node:path'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import type { PGlite } from '@electric-sql/pglite'
import { env, testEnv } from '@yaac/shared/env'
import { PACKAGE_ROOT, serverLocalPath } from '@yaac/shared/paths'
import { forgetSecretConfig } from './secret-key'

/**
 * The server's on-disk PGlite database (embedded Postgres, WAL-backed).
 *
 * Rows are db's alone, and a layer that could reach `getDb` could build its
 * own queries against the tables, so the handle itself stays off the barrel:
 * what the rest of the server gets from this module is the void-returning
 * `openDb`/`closeDb` pair, and otherwise only the row functions.
 *
 * Server-only invariant: PGlite is single-process, so this handle must only
 * ever be opened by the server process — the proxy pod, auth-daemon, and CLI
 * share the data dir but never touch `<dataDir>/db`. That is why `dbDir()`
 * stays private here instead of living in shared paths, and why `@yaac/server`
 * is un-importable from those packages (eslint zones + pnpm strict
 * node_modules). `.server.lock` is the single-writer guard: runServer opens
 * the DB only after `acquireLock` succeeds.
 */

export type Db = PgliteDatabase & { $client: PGlite }

/** Where the checked-in migration SQL lives. Unlike DOCKERFILES_DIR (same
 *  relative suffix in both modes because dockerfiles/ sits at the repo root),
 *  the dev-mode source here is under packages/server while the build copies
 *  it to dist/drizzle — the one place this second-level bundled/dev
 *  conditional is needed. */
const MIGRATIONS_DIR = env.bundled
  ? path.join(PACKAGE_ROOT, 'drizzle')
  : path.join(PACKAGE_ROOT, 'packages', 'server', 'drizzle')

let cached: { dir: string; promise: Promise<Db> } | null = null

/**
 * Shared-instance mode (unit tests only — see `testEnv.sharedTestDb`). One
 * in-memory PGlite serves every data dir the process visits; switching dirs
 * truncates instead of opening a second instance, which is what a fresh dir
 * gives a test anyway. Kept behind the flag because the on-disk handle is the
 * real contract — its own tests (test/db/client.test.ts) opt out and
 * exercise the instance-per-dir path.
 */
let sharedDb: Promise<Db> | null = null
let sharedDir: string | null = null

async function openSharedDb(): Promise<Db> {
  const db = drizzle({ connection: { dataDir: 'memory://' } })
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR })
  return db
}

/**
 * Empty every table the migrations created, so the next data dir starts as
 * clean as a freshly-migrated one. Read out of the catalog rather than the
 * schema module: this must cover whatever the checked-in migrations actually
 * built, including tables a later migration adds and this file never names.
 * `RESTART IDENTITY` so sequence-backed ids don't leak a previous test's
 * count; `CASCADE` because TRUNCATE refuses a table another one references.
 * drizzle's own bookkeeping lives in the `drizzle` schema, so filtering to
 * `public` leaves the applied-migration list intact.
 */
async function wipeSharedDb(db: Db): Promise<void> {
  const { rows } = await db.$client.query<{ tablename: string }>(
    'SELECT tablename FROM pg_tables WHERE schemaname = \'public\'',
  )
  if (rows.length === 0) return
  const list = rows.map((r) => `"${r.tablename}"`).join(', ')
  await db.$client.exec(`TRUNCATE ${list} RESTART IDENTITY CASCADE`)
}

function getSharedDb(dir: string): Promise<Db> {
  if (cached?.dir === dir) return cached.promise
  const promise = (sharedDb ??= openSharedDb()).then(async (db) => {
    // Only a *change* of dir wipes: closeDb() drops the cache without
    // closing anything, and reopening the same dir after it must still see
    // the data, exactly as the on-disk handle's checkpoint does.
    if (sharedDir !== dir) {
      await wipeSharedDb(db)
      sharedDir = dir
    }
    return db
  })
  cached = { dir, promise }
  return promise
}

/**
 * SERVER-LOCAL, hard requirement: pglite is an embedded single-writer
 * store and must never live on a network filesystem.
 */
function dbDir(): string {
  return serverLocalPath('db')
}

async function openHandle(dir: string, prev: Promise<Db> | null): Promise<Db> {
  // A dangling previous handle (setDataDir moved the data dir mid-process,
  // which only unit tests do) would leak a postgres instance — close it.
  if (prev) await prev.then((db) => db.$client.close()).catch(() => undefined)
  // 0700, not the default: web-session ids and tokens stored inside are
  // bearer-equivalent. chmod after mkdir so a pre-existing dir (or a umask)
  // can't leave it wider.
  await fs.mkdir(dir, { recursive: true })
  await fs.chmod(dir, 0o700)
  const db = drizzle({ connection: { dataDir: dir } })
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR })
  return db
}

/**
 * Open the database, running any pending migrations. The composition root
 * calls this once the single-writer lock is held; every db read and write
 * after it shares the connection it opened. Void-returning on purpose — the
 * handle is this module's, and callers get rows through the row functions.
 */
export async function openDb(): Promise<void> {
  await getDb()
}

/**
 * Lazy singleton handle, keyed by the current data dir. Internal: only the
 * row functions in this folder may name it. Single-flighted:
 * concurrent callers during open share one promise; a failed open clears
 * the cache so the next caller retries instead of inheriting the rejection.
 */
export function getDb(): Promise<Db> {
  const dir = dbDir()
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

/**
 * Test-only: put the database back to freshly-migrated — no rows — while
 * leaving the data dir's *files* alone. What a
 * test means by "the user upgraded into a new database": deleting
 * `<dataDir>/db` says that only to the on-disk handle, and says nothing at
 * all to the shared in-memory one, so tests ask for the state instead of
 * the mechanism and get it in either mode.
 */
export async function _freshDbForTests(): Promise<void> {
  if (testEnv.sharedTestDb) {
    cached = null
    await wipeSharedDb(await (sharedDb ??= openSharedDb()))
    return
  }
  await closeDb()
  await fs.rm(dbDir(), { recursive: true, force: true })
}

/** Close the handle so PGlite checkpoints cleanly (dev-watch restarts, test
 *  teardown before temp-dir removal). Idempotent. */
export async function closeDb(): Promise<void> {
  const prev = cached
  cached = null
  // The encryption key is resolved per data dir like the handle is, so the
  // two caches are dropped together — otherwise a test that moves to a new
  // data dir would seal its rows under the previous dir's generated key.
  forgetSecretConfig()
  // Shared-instance mode: the handle outlives every data dir that borrows
  // it, so closing it here would strand the next test with a dead postgres.
  // Dropping the cache is the whole job — the next dir wipes on arrival.
  if (testEnv.sharedTestDb) return
  if (!prev) return
  try {
    const db = await prev.promise
    await db.$client.close()
  } catch {
    // Open failed — nothing live to close.
  }
}
