import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { TestProject } from 'vitest/node'
import { dumpMigratedDb } from '@yaac/server/db/client'
import { findRepoRoot } from '@yaac/shared/paths'

/**
 * The migrated-database dump the suites start every new database from
 * (`testEnv.dbSnapshot`), so a test file or a spawned server loads one file
 * instead of replaying every migration. A vitest global setup: it builds
 * the dump once per set of migrations, and hands its path to the workers,
 * where vitest-setup exports it for the code under test and the servers the
 * tests spawn.
 *
 * The dump is named for a hash of what it was made with: the migration
 * files, and the installed PGlite and drizzle-orm, since it is a raw
 * Postgres data dir holding drizzle's migration journal. A changed
 * migration or an upgrade of either makes a new one, where an old dump
 * would fail every database it opens. It is kept in the checkout's
 * `node_modules/.cache` across runs.
 */

declare module 'vitest' {
  export interface ProvidedContext {
    dbSnapshot: string
  }
}

const REPO_ROOT = findRepoRoot(import.meta.dirname)
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'packages', 'server', 'drizzle')
const CACHE_DIR = path.join(REPO_ROOT, 'node_modules', '.cache', 'yaac')
const PREFIX = 'db-snapshot-'

/** The packages whose version decides what a dump holds. */
const DUMP_PACKAGES = ['@electric-sql/pglite', 'drizzle-orm']

/**
 * The version of `pkg` as `@yaac/server` resolves it. Its manifest is not
 * exported, so it is found along the server's resolution paths.
 */
async function serverDependencyVersion(pkg: string): Promise<string> {
  const require = createRequire(path.join(REPO_ROOT, 'packages', 'server', 'package.json'))
  for (const dir of require.resolve.paths(pkg) ?? []) {
    const manifest = await fs.readFile(path.join(dir, pkg, 'package.json'), 'utf8').catch(() => null)
    if (manifest !== null) return (JSON.parse(manifest) as { version: string }).version
  }
  throw new Error(`@yaac/server does not resolve ${pkg}`)
}

async function dumpHash(): Promise<string> {
  const hash = createHash('sha256')
  for (const pkg of DUMP_PACKAGES) hash.update(`${pkg}@${await serverDependencyVersion(pkg)}\n`)
  const files = (await fs.readdir(MIGRATIONS_DIR, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name)).sort()
  for (const file of files) hash.update(file).update(await fs.readFile(file))
  return hash.digest('hex').slice(0, 16)
}

export async function setup(project: TestProject): Promise<void> {
  const name = `${PREFIX}${await dumpHash()}.tar`
  const file = path.join(CACHE_DIR, name)
  if (!await fs.access(file).then(() => true, () => false)) {
    await fs.mkdir(CACHE_DIR, { recursive: true })
    // Renamed into place, so a project's setup running beside this one
    // never reads half a dump.
    const partial = `${file}.${String(process.pid)}`
    await fs.writeFile(partial, Buffer.from(await (await dumpMigratedDb()).arrayBuffer()))
    await fs.rename(partial, file)
    for (const other of await fs.readdir(CACHE_DIR)) {
      if (other.startsWith(PREFIX) && other.endsWith('.tar') && other !== name) await fs.rm(path.join(CACHE_DIR, other), { force: true })
    }
  }
  project.provide('dbSnapshot', file)
}
