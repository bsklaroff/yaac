import fs from 'node:fs/promises'
import path from 'node:path'
// The migration is the one thing that addresses the data dir ROOT by
// design: it is what moves a pre-split install's files off it.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { getDataDir, globalRoot, nodeLocalRoot, serverLocalRoot } from '#paths'
import { SERVER_LOCK_FILENAME, isLockLive, parseServerLock } from '#server-lock-file'

/**
 * LEGACY COMPAT (docs/legacy-compat-shims.md). Move a data dir written
 * before the storage tiers were folders into the three-folder layout:
 * `global/`, `server-local/` and `node-local/` under the data dir root,
 * which then holds nothing else of yaac's.
 *
 * Runs on a HOST only — never in the server pod, where the roots are
 * mounts and a rename across claims is a copy — and before anything else
 * reads the data dir: `runServer` and `startServer` call it ahead of
 * `ensureDataDir` and the lock read, `yaac cluster install` after it has
 * stopped the server pod. Nothing on the data dir precedes it, because
 * every other legacy shim reads a path this moves, and the order between
 * them is where data would be lost.
 *
 * All or nothing, row by row. Each row is one `rename(2)` on one
 * filesystem — metadata, no time proportional to the data — and a row that
 * fails for any reason but "source absent" throws with the row named, so
 * the server does not start on a half-moved tree. A partial run is not a
 * corrupt state: every completed row is atomic and the next run resumes at
 * the first row whose source still exists. The ORDER of the rows is what
 * makes that true: `secret.key` moves before `db/` so no state can exist
 * in which a database has moved without its key (a server that found one
 * would mint a fresh key and seal every new row under it, after which the
 * old rows are unrecoverable), and `.credentials/` before `projects/` for
 * the env-settings importer that reads one to fill the other.
 *
 * An EMPTY existing destination directory is treated as absent (rmdir,
 * then rename), so an `ensureDataDir` that ran first cannot shadow a full
 * `projects/` with an empty `global/projects`. A NON-empty destination
 * beside a still-present source is a mixed layout this cannot resolve on
 * its own; it refuses, naming both halves, rather than guess.
 *
 * Idempotent, and a no-op on a fresh data dir.
 */
export async function migrateDataDirLayout(
  log: (message: string) => void = () => { /* quiet by default */ },
): Promise<void> {
  const root = getDataDir()
  if (!await exists(root)) return

  await refuseLiveLegacyLock(root)

  const rows: Array<[string, string]> = [
    // SERVER-LOCAL. The key FIRST — see above.
    [path.join(root, 'secret.key'), serverLocalPath('secret.key')],
    [path.join(root, '.credentials'), serverLocalPath('.credentials')],
    [path.join(root, 'db'), serverLocalPath('db')],
    [path.join(root, 'build'), serverLocalPath('build')],
    [path.join(root, 'models'), serverLocalPath('models')],
    // GLOBAL.
    [path.join(root, 'projects'), path.join(globalRoot(), 'projects')],
    // GLOBAL: the pre-object proxy's hostPath, which `seedProxyObjects`
    // reads through `globalPath` from inside the pod.
    [path.join(root, 'run', 'proxy-data'), path.join(globalRoot(), 'run', 'proxy-data')],
  ]
  for (const [from, to] of rows) await moveRow(from, to, log)
  await mergeLogRow(path.join(root, 'server.log'), serverLocalPath('server.log'), log)

  // NODE-LOCAL, per project, after `projects/` has moved: the pnpm store
  // and the ephemeral module dirs under it.
  const projectsDir = path.join(globalRoot(), 'projects')
  for (const slug of await fs.readdir(projectsDir).catch((): string[] => [])) {
    await moveRow(
      path.join(projectsDir, slug, '.cached-packages'),
      path.join(nodeLocalRoot(), 'projects', slug, '.cached-packages'),
      log,
    )
  }

  // The old node-local image store. Its generations are root-owned (a
  // node-side pod wrote them), and `rename(2)` of a directory into a new
  // parent needs write permission on the directory itself — so this may
  // be refused, and a node-side pod may already have written the new
  // location. It is a re-derivable cache either way: say what to run and
  // move on, never fail the start over it.
  const sharedImages = path.join(root, 'shared-images')
  if (await exists(sharedImages)) {
    try {
      await moveRow(sharedImages, path.join(nodeLocalRoot(), 'shared-images'), log)
    } catch {
      log(
        `[layout] ${sharedImages} could not be moved (root-owned, or the new store `
        + 'already exists); it is a re-derivable image cache, so remove it by hand: '
        + `sudo rm -rf ${sharedImages}`,
      )
    }
  }

  // `run/` held the proxy data above and content-keyed public-key files
  // the server regenerates on demand; nothing reads it at the root now.
  const run = path.join(root, 'run')
  await fs.rm(path.join(run, 'ssh-pub'), { recursive: true, force: true })
  await fs.rmdir(run).catch(() => { /* absent, or holds something not ours */ })
}

/**
 * The log is the one row whose destination the migrating command itself
 * writes to — every `[layout]` line above lands in the new `server.log`
 * through `serverLog` — so it is a merge, not a rename: the old file's
 * lines, then whatever the new one already holds, written whole and
 * renamed into place, after which the old file is unlinked.
 */
async function mergeLogRow(
  from: string,
  to: string,
  log: (message: string) => void,
): Promise<void> {
  if (!await exists(from)) return
  if (!await exists(to)) return moveRow(from, to, log)
  const merged = `${await fs.readFile(from, 'utf8')}${await fs.readFile(to, 'utf8')}`
  const tmp = `${to}.merge-${String(process.pid)}`
  await fs.writeFile(tmp, merged)
  await fs.rename(tmp, to)
  await fs.unlink(from)
  log(`[layout] merged ${from} into ${to}`)
}

function serverLocalPath(...rest: string[]): string {
  return path.join(serverLocalRoot(), ...rest)
}

/**
 * The lock is never moved: a server writes its own at the new path. A
 * LIVE one at the old path is a pre-split server still holding this data
 * dir, and renaming `db/` under it would strand or corrupt its database.
 * A stale one is unlinked so nothing can read it as a holder later.
 */
async function refuseLiveLegacyLock(root: string): Promise<void> {
  const lockPath = path.join(root, SERVER_LOCK_FILENAME)
  let raw: string
  try {
    raw = await fs.readFile(lockPath, 'utf8')
  } catch {
    return
  }
  const lock = parseServerLock(raw)
  if (lock && await isLockLive(lock)) {
    throw new Error(
      'a yaac server from before the storage-tier split is still running on '
      + `${root} (pid ${String(lock.pid)}, port ${String(lock.port)}), and its data `
      + 'dir cannot be rearranged underneath it.\n'
      + '    Stop it first — `yaac server stop` for a host server, or scale the '
      + 'Deployment to zero — then run this command again.',
    )
  }
  await fs.unlink(lockPath).catch(() => { /* already gone */ })
}

/**
 * One row: `from` → `to` by rename, when `from` exists and `to` is absent
 * or an empty directory. Throws with the row named on anything else.
 */
async function moveRow(
  from: string,
  to: string,
  log: (message: string) => void,
): Promise<void> {
  if (!await exists(from)) return
  const dest = await fs.lstat(to).catch(() => null)
  if (dest !== null) {
    const empty = dest.isDirectory() && (await fs.readdir(to)).length === 0
    if (!empty) {
      throw new Error(
        `data dir layout: cannot move ${from} to ${to} — the destination already `
        + 'exists and is not empty, so both halves of this install are in play. '
        + 'Merge or remove one of them by hand, then retry.',
      )
    }
    await fs.rmdir(to)
  }
  await fs.mkdir(path.dirname(to), { recursive: true })
  try {
    await fs.rename(from, to)
  } catch (err) {
    throw new Error(
      `data dir layout: could not move ${from} to ${to} (${String(err)}); `
      + 'the server will not start on a half-moved data dir.',
      { cause: err },
    )
  }
  log(`[layout] moved ${from} -> ${to}`)
}

async function exists(p: string): Promise<boolean> {
  return fs.lstat(p).then(() => true, () => false)
}
