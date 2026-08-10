import fs from 'node:fs/promises'
import path from 'node:path'
import { getProjectsDir, serverLocalPath } from '@yaac/shared/paths'
import { projectDir } from '@yaac/shared/project-paths'
import { serverLog } from '#log'

/**
 * The four stores yaac kept before it had a database, and the import that
 * swept them into it is gone. This is what stands in its place: not a
 * migration, just a tripwire that says so out loud.
 *
 * The failure it exists to make legible is the one an empty database cannot
 * distinguish on its own. `@bsklaroff/yaac` ships to npm, so an install can
 * jump from a pre-database version straight to a build with no importer in it
 * — and then comes up looking *fine*: migrations run against an empty DB, the
 * UI renders, and every worktree that predates the tables is simply absent.
 * Its checkout is still on disk and still has its diff; nothing says so.
 * Tokens read as revoked, titles and preferences as unset. Without this, the
 * only evidence is four files nobody is looking at, and the reasonable
 * conclusion for a user to draw is that yaac lost their work.
 *
 * Their presence is good evidence, not a guess: the importer unlinked each
 * file once its rows were committed, so a file that is still here was never
 * imported by anything.
 *
 * It warns and returns — it does not refuse to start. A stray `tokens.json`
 * is not worth bricking a working install over, and the data it names is
 * intact on disk either way: the point is to be read, not to block.
 */

/** `<file>` paths that only a pre-database yaac ever wrote. */
function installScopedPaths(): string[] {
  return [serverLocalPath('.preferences.json'), serverLocalPath('tokens.json')]
}

/** The same, per project — titles and opencode's per-session snapshots. */
function projectScopedPaths(slug: string): string[] {
  return [
    path.join(projectDir(slug), 'session-titles.json'),
    path.join(projectDir(slug), 'opencode-meta'),
  ]
}

async function firstExisting(paths: string[]): Promise<string[]> {
  const found = await Promise.all(
    paths.map(async (p) => (await fs.stat(p).catch(() => null)) === null ? null : p),
  )
  return found.filter((p): p is string => p !== null)
}

/**
 * Log a warning naming every pre-database store still on disk. Called from
 * `runServer` once the DB is open, in the slot the importer used to occupy.
 *
 * Cost on a healthy install is two stats plus one readdir of the projects dir
 * and two stats per project, all of which miss.
 */
export async function warnAboutUnimportedLegacyData(): Promise<void> {
  const stale = [...await firstExisting(installScopedPaths())]
  const slugs = await fs.readdir(getProjectsDir()).catch((): string[] => [])
  for (const slug of slugs) stale.push(...await firstExisting(projectScopedPaths(slug)))
  if (stale.length === 0) return

  serverLog(
    '[server] ============================================================\n'
    + '[server] Found data from a yaac that predates the database, which\n'
    + '[server] this build has no importer for. It has NOT been read:\n'
    + stale.map((p) => `[server]   ${p}\n`).join('')
    + '[server]\n'
    + '[server] Worktrees created before the upgrade will be missing from\n'
    + '[server] the stopped listing (their checkouts are intact on disk under\n'
    + '[server] projects/<slug>/worktrees/), saved client tokens will read as\n'
    + '[server] revoked, and titles and preferences will read as unset.\n'
    + '[server]\n'
    + '[server] To recover it, install a yaac release old enough to still\n'
    + '[server] carry the importer, start the server once to let it migrate,\n'
    + '[server] then upgrade back to this one. To discard it, delete the\n'
    + '[server] files above — tokens.json holds credentials, so prefer\n'
    + '[server] deleting it over leaving it unread.\n'
    + '[server] ============================================================',
  )
}
