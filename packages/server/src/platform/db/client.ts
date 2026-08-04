import fs from 'node:fs/promises'
import path from 'node:path'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import type { PGlite } from '@electric-sql/pglite'
import { env } from '@yaac/shared/env'
import { PACKAGE_ROOT, serverLocalPath } from '@yaac/shared/paths'

/**
 * The server's on-disk PGlite database (embedded Postgres, WAL-backed).
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
 * SERVER-LOCAL, hard requirement: pglite is an embedded single-writer
 * store and must never live on a network filesystem.
 */
function dbDir(): string {
  return serverLocalPath('db')
}

async function openDb(dir: string, prev: Promise<Db> | null): Promise<Db> {
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
 * Lazy singleton handle, keyed by the current data dir. Single-flighted:
 * concurrent callers during open share one promise; a failed open clears
 * the cache so the next caller retries instead of inheriting the rejection.
 */
export function getDb(): Promise<Db> {
  const dir = dbDir()
  if (cached?.dir !== dir) {
    const promise = openDb(dir, cached?.promise ?? null)
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
  if (!prev) return
  try {
    const db = await prev.promise
    await db.$client.close()
  } catch {
    // Open failed — nothing live to close.
  }
}
