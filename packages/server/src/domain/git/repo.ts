import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { serverLocalPath } from '@yaac/shared/paths'
import { createKeyedMutex } from '#lib/keyed-mutex'
import { readRepoConfig, runGit } from './run'
import type { GitTarget } from './run'
import { gitEnvForCredential, injectTokenIntoUrl, torEnv } from './transport'
import type { ResolvedGitCredential } from './transport'

/**
 * Git operations on a project's main clone and the checkouts that borrow
 * from it: clone, fetch, gc, branch and tree lookups, and checkout creation.
 * Every call goes through `runGit` (docs/server-git.md). The remote URL
 * always comes from the project row, never from the repository.
 */

const repo = (repoPath: string): GitTarget => ({ kind: 'repo', repoPath })

export async function cloneRepo(
  remoteUrl: string,
  destPath: string,
  credential: ResolvedGitCredential | null,
): Promise<void> {
  const config = path.join(destPath, '.git', 'config')
  if (credential?.kind === 'https') {
    const authedUrl = injectTokenIntoUrl(remoteUrl, credential.token)
    await runGit({ kind: 'none' }, ['clone', authedUrl, destPath], { env: torEnv(), remoteUrl })
    // Strip credentials from the stored remote URL.
    await runGit({ kind: 'none' }, ['config', '--file', config, 'remote.origin.url', remoteUrl])
  } else {
    // SSH signs through the in-process agent; with no credential the clone
    // is unauthenticated (fine for public HTTPS repos).
    await runGit({ kind: 'none' }, ['clone', remoteUrl, destPath], {
      env: await gitEnvForCredential(credential),
      remoteUrl,
    })
  }
  // Git run directly in the main clone (by a user or a containerless agent,
  // without the server's pins) must not auto-gc away borrowed objects.
  for (const key of NEVER_PRUNE_KEYS) await runGit({ kind: 'none' }, ['config', '--file', config, key, 'never'])
}

export async function getDefaultBranch(repoPath: string): Promise<string> {
  try {
    const ref = await runGit(repo(repoPath), ['symbolic-ref', 'refs/remotes/origin/HEAD'])
    const match = ref.trim().match(/^refs\/remotes\/origin\/(.+)$/)
    if (match) return match[1]
  } catch {
    // Fallback: origin/HEAD may not be set (e.g. local-only repos)
  }
  return (await runGit(repo(repoPath), ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
}

/** True when `refs/remotes/origin/<branch>` exists in the repo. */
export async function remoteBranchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await resolveRemoteRef(repoPath, branch)
    return true
  } catch {
    return false
  }
}

/**
 * All remote-tracking branch names (without the `origin/` prefix), most
 * recently committed first — the order a branch picker wants on top.
 * Excludes the `HEAD` symref.
 */
export async function listRemoteBranches(repoPath: string): Promise<string[]> {
  const out = await runGit(repo(repoPath), [
    'for-each-ref', '--sort=-committerdate', '--format=%(refname:strip=3)', 'refs/remotes/origin',
  ])
  return out.split('\n').map((l) => l.trim()).filter((l) => l.length > 0 && l !== 'HEAD')
}

/** The commit `refs/remotes/origin/<branch>` names; rejects when absent. */
export async function resolveRemoteRef(repoPath: string, branch: string): Promise<string> {
  return resolveCommit(repoPath, `refs/remotes/origin/${branch}`)
}

async function resolveCommit(repoPath: string, ref: string): Promise<string> {
  return (await runGit(repo(repoPath), ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim()
}

/** Names of the subtrees directly under `treePath` at `ref`, or [] when that
 *  tree is absent. Only trees: blobs, symlinks included, are skipped. */
export async function listTreeSubdirs(repoPath: string, ref: string, treePath: string): Promise<string[]> {
  let out: string
  try {
    out = await runGit(repo(repoPath), ['ls-tree', '-z', `${ref}:${treePath}`])
  } catch {
    return []
  }
  return out.split('\0')
    .filter((entry) => entry.split(' ')[1] === 'tree')
    .map((entry) => entry.slice(entry.indexOf('\t') + 1))
}

/** The blob at `ref:blobPath` as text, or null when there is none. Read
 *  with `cat-file`, which applies no conversion of any kind. */
export async function readBlobAt(repoPath: string, ref: string, blobPath: string): Promise<string | null> {
  try {
    return await runGit(repo(repoPath), ['cat-file', 'blob', `${ref}:${blobPath}`])
  } catch {
    return null
  }
}

/**
 * Per-repo fetch lock. Concurrent fetches on one repo fail on git's ref locks
 * ("cannot lock ref 'refs/remotes/origin/<b>'"), which happens when a create,
 * a spare's re-branch and a branch listing fetch together. Different repos
 * still fetch in parallel.
 */
const fetchOriginMutex = createKeyedMutex()
/** Per repo, the fetch queued behind the running one, which later callers
 *  join. */
const queuedFetches = new Map<string, Promise<void>>()

/**
 * Where the server records when it last fetched a repo (see
 * lastFetchedAtMs). Server-private so no pod can forge it, and on disk so it
 * survives restarts.
 */
function fetchRecord(repoPath: string): string {
  return serverLocalPath('git-fetched', createHash('sha256').update(repoPath).digest('hex').slice(0, 32))
}

/**
 * Fetch every branch of `remoteUrl` into `refs/remotes/origin/*`, pruning
 * branches origin deleted, so a deleted branch leaves the picker and a create
 * naming it is refused. Only that refspec is pruned; local `agent/*` heads
 * and `origin/HEAD` are kept. The URL comes from the project row, since a pod
 * could have written the repo's own `remote.origin.*`.
 *
 * Fetches of one repo run one at a time. A caller arriving mid-fetch joins
 * the single fetch queued behind it, which starts after all of them asked,
 * so a burst of callers costs two fetches.
 */
export function fetchOrigin(
  repoPath: string,
  remoteUrl: string,
  credential: ResolvedGitCredential | null,
): Promise<void> {
  const queued = queuedFetches.get(repoPath)
  if (queued) return queued
  const run = fetchOriginMutex(repoPath, async () => {
    // Started, so later callers need a new queued fetch.
    queuedFetches.delete(repoPath)
    const url = credential?.kind === 'https' ? injectTokenIntoUrl(remoteUrl, credential.token) : remoteUrl
    const env = credential?.kind === 'https' ? torEnv() : await gitEnvForCredential(credential)
    await runGit(repo(repoPath), [
      'fetch', '--prune', url, '+refs/heads/*:refs/remotes/origin/*', '--update-head-ok',
    ], { env, remoteUrl })
    await fs.mkdir(path.dirname(fetchRecord(repoPath)), { recursive: true })
    await fs.writeFile(fetchRecord(repoPath), String(Date.now()))
  })
  queuedFetches.set(repoPath, run)
  return run
}


/**
 * The main clone's only gc, run after fetches (docs/server-git.md).
 * Workspace clones borrow objects via `objects/info/alternates`, and the main
 * clone can't see which, so it never deletes an object (unreachable ones go
 * to a cruft pack). The never-prune settings are on the command line to
 * override config; never pass `--prune`, which would override them.
 *
 * Runs under the fetch lock so it never races a fetch. `gc.auto` restores
 * git's default, overriding the runner's `gc.auto=0` pin.
 */
export function maintainRepo(repoPath: string): Promise<void> {
  return fetchOriginMutex(repoPath, async () => {
    await runGit(repo(repoPath), [
      '-c', 'gc.auto=6700',
      '-c', 'gc.autoDetach=false',
      '-c', 'gc.pruneExpire=never',
      '-c', 'gc.reflogExpire=never',
      '-c', 'gc.reflogExpireUnreachable=never',
      '-c', 'gc.worktreePruneExpire=never',
      'gc', '--auto', '--quiet',
    ])
  })
}

/**
 * When `origin/<branch>` was last fetched, into the main clone or the
 * checkout at `checkoutGitDir`. Takes the newest of: the server's own record
 * (`fetchRecord`, since its FETCH_HEAD is in a throwaway dir), the branch's
 * reflog in either repo, and the checkout's FETCH_HEAD (from an agent's own
 * fetch). Files are only lstat'd for mtimes, so a planted symlink is
 * harmless.
 */
export async function lastFetchedAtMs(
  repoPath: string,
  branch: string,
  checkoutGitDir: string,
): Promise<number | null> {
  const mtimes = await Promise.all([
    path.join(repoPath, '.git', 'logs', 'refs', 'remotes', 'origin', branch),
    path.join(checkoutGitDir, 'logs', 'refs', 'remotes', 'origin', branch),
    path.join(checkoutGitDir, 'FETCH_HEAD'),
  ].map((p) => fs.lstat(p).then((st) => st.mtimeMs, () => 0)))
  const recorded = Number(await fs.readFile(fetchRecord(repoPath), 'utf8').catch(() => '0')) || 0
  const newest = Math.max(recorded, ...mtimes)
  return newest > 0 ? newest : null
}

/** Never-prune keys for the main clone's real config, read by git run there
 *  without the server's pins (`cloneRepo`, `ensureNeverPrune`). */
export const NEVER_PRUNE_KEYS = ['gc.pruneExpire', 'gc.reflogExpire', 'gc.reflogExpireUnreachable']

/**
 * Write the never-prune keys into the main clone's real config while it
 * still has linked checkouts (docs/legacy-compat-shims.md). A legacy pod
 * auto-gcs that `.git` with its own git, which can't see the clones' refs
 * and would eventually delete objects they borrow. Unneeded once
 * `worktrees/` is gone. Written only when a key is missing, since a write
 * replaces the file's inode under legacy pods' cached view.
 */
export async function ensureNeverPrune(repoPath: string): Promise<void> {
  const gitDir = path.join(repoPath, '.git')
  if (!await fs.stat(path.join(gitDir, 'worktrees')).then(() => true, () => false)) return
  const missing: string[] = []
  for (const key of NEVER_PRUNE_KEYS) {
    if ((await readRepoConfig(repoPath, key)).at(-1) !== 'never') missing.push(key)
  }
  if (missing.length === 0) return
  // `git config --file` writes through a symlink, and a pod could plant one.
  if (!(await fs.lstat(path.join(gitDir, 'config'))).isFile()) {
    throw new Error(`${gitDir}/config is not a regular file`)
  }
  for (const key of missing) {
    await runGit({ kind: 'none' }, ['config', '--file', path.join(gitDir, 'config'), key, 'never'])
  }
}

/** Where a checkout's git dir is assembled before being moved into place:
 *  beside the checkout, where no workspace mounts it. */
export function stagingGitDir(workspacePath: string): string {
  return path.join(path.dirname(workspacePath), `.staging-${path.basename(workspacePath)}`, '.git')
}

/**
 * Create an empty clone of the main clone at `gitDir`: config with the
 * project row's URL as `origin` and `branch`'s upstream, and an alternates
 * line borrowing all objects from the main clone. `refs` (`<sha> <refname>`
 * lines) are written as `packed-refs` to avoid thousands of files per
 * workspace.
 *
 * The alternates path is the server's; a pod mounts the main clone at the
 * same path (docs/server-git.md), so it resolves everywhere.
 */
export async function initClone(repoPath: string, gitDir: string, params: {
  remoteUrl: string
  branch: string
  baseBranch: string | null
  refs: string[]
  originHead: string | null
}): Promise<void> {
  if (await fs.lstat(path.join(repoPath, '.git', 'shallow')).then(() => true, () => false)) {
    throw new Error(`${repoPath} is a shallow clone, which a workspace cannot borrow from`)
  }
  const format = (await runGit(repo(repoPath), ['rev-parse', '--show-object-format'])).trim()
  // No template, so no sample hooks or `info/exclude`.
  await runGit({ kind: 'none' }, ['init', '--quiet', '--bare', '--template=', `--object-format=${format}`, gitDir])
  const settings: Array<[string, string]> = [
    ['core.bare', 'false'],
    ['core.logallrefupdates', 'true'],
    ['remote.origin.url', params.remoteUrl],
    ['remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
  ]
  if (params.baseBranch !== null) {
    settings.push(
      [`branch.${params.branch}.remote`, 'origin'],
      [`branch.${params.branch}.merge`, `refs/heads/${params.baseBranch}`],
    )
  }
  for (const [key, value] of settings) {
    await runGit({ kind: 'none' }, ['config', '--file', path.join(gitDir, 'config'), key, value])
  }
  await fs.mkdir(path.join(gitDir, 'objects', 'info'), { recursive: true })
  await fs.writeFile(path.join(gitDir, 'objects', 'info', 'alternates'), `${path.join(repoPath, '.git', 'objects')}\n`)
  await fs.writeFile(path.join(gitDir, 'packed-refs'), params.refs.map((l) => `${l}\n`).join(''))
  if (params.originHead !== null) {
    await runGit({ kind: 'private', gitDir }, ['symbolic-ref', 'refs/remotes/origin/HEAD', params.originHead])
  }
}

/** `<sha> <refname>` for every main-clone ref under `prefixes`, plus the
 *  target of the symbolic `origin/HEAD`. */
export async function mainRefs(
  repoPath: string,
  prefixes: string[],
): Promise<{ refs: string[]; originHead: string | null }> {
  const out = await runGit(repo(repoPath), ['for-each-ref', '--format=%(objectname) %(refname) %(symref)', ...prefixes])
  const refs: string[] = []
  let originHead: string | null = null
  for (const line of out.split('\n')) {
    const [sha, ref, symref] = line.split(' ')
    if (!ref) continue
    if (symref) {
      if (ref === 'refs/remotes/origin/HEAD') originHead = symref
      continue
    }
    refs.push(`${sha} ${ref}`)
  }
  return { refs, originHead }
}

/**
 * Create a workspace's checkout at `workspacePath`, which may already exist
 * with entries (mount points for ephemeral module dirs are created first).
 *
 * The checkout is its own clone (docs/server-git.md): a full `.git` with a
 * snapshot of the main clone's `origin/*` and tags, `branch` at
 * `origin/<baseBranch>` tracking it, and all objects borrowed via
 * alternates. It is built in a staging dir, then renamed in as
 * `<workspacePath>/.git`, so the destination's inode never changes and a pod
 * can bind `/workspace` before this runs.
 *
 * The checkout is forced: callers reuse a destination that already has a
 * `.git`, so anything else there is a crashed attempt's partial tree. A
 * failure leaves no `.git`, so a retry starts over.
 */
export async function createCheckout(repoPath: string, workspacePath: string, params: {
  branch: string
  baseBranch: string
  remoteUrl: string
}): Promise<void> {
  await ensureNeverPrune(repoPath)
  const startSha = await resolveRemoteRef(repoPath, params.baseBranch)
  const gitDir = stagingGitDir(workspacePath)
  await fs.rm(path.dirname(gitDir), { recursive: true, force: true })
  await fs.mkdir(path.dirname(gitDir), { recursive: true })
  try {
    await initClone(repoPath, gitDir, {
      ...params,
      ...await mainRefs(repoPath, ['refs/remotes/origin', 'refs/tags']),
    })
    await runGit({ kind: 'private', gitDir }, ['update-ref', `refs/heads/${params.branch}`, startSha])
    await runGit({ kind: 'private', gitDir }, ['symbolic-ref', 'HEAD', `refs/heads/${params.branch}`])
    await fs.mkdir(workspacePath, { recursive: true })
    await runGit({ kind: 'private', gitDir, workTree: workspacePath }, ['checkout', '--force', '--quiet'])
    await fs.rename(gitDir, path.join(workspacePath, '.git'))
  } finally {
    await fs.rm(path.dirname(gitDir), { recursive: true, force: true })
  }
}
