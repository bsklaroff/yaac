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
 * Git operations against a project's main clone and the checkouts that
 * borrow from it — clone, fetch and gc, branch and tree lookups, and
 * creating a checkout.
 *
 * The process boundary for domain the way kubectl is the driver's: every
 * git process the server starts is one of these, and each runs through
 * `runGit` (docs/server-git.md). A remote URL is always the caller's — the
 * project row's — and never read back out of the repository.
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
    // SSH signs through the in-process agent; no credential is an
    // unauthenticated clone (works for public HTTPS repos).
    await runGit({ kind: 'none' }, ['clone', remoteUrl, destPath], {
      env: await gitEnvForCredential(credential),
      remoteUrl,
    })
  }
  // For any git that runs in the main clone directly — a user, or a
  // containerless agent, neither under the server's pins — whose default
  // auto-gc would prune objects the checkouts borrow.
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
 * Per-repo queue for fetches: two concurrent fetches on one repo race
 * git's per-ref locks when both try to move the same remote-tracking ref
 * ("cannot lock ref 'refs/remotes/origin/<b>'") — routine on the shared
 * project repo when a user create, a prewarm spare's re-branch prep, or a
 * branch listing fetch at once. Keyed by repo path (the contended
 * resource); fetches on different repos still run in parallel.
 */
const fetchOriginMutex = createKeyedMutex()
/** Per repo, the fetch that is queued behind a running one and not yet
 *  started — which every caller arriving meanwhile joins. */
const queuedFetches = new Map<string, Promise<void>>()

/**
 * Where the server records when it last fetched a repo — see lastFetchedAtMs.
 * Server-private, so no pod can forge or plant a link at it, and on disk, so
 * a restart does not forget it.
 */
function fetchRecord(repoPath: string): string {
  return serverLocalPath('git-fetched', createHash('sha256').update(repoPath).digest('hex').slice(0, 32))
}

/**
 * Fetch every branch of `remoteUrl` into `refs/remotes/origin/*`, pruning
 * the ones origin has deleted — so a merged-and-deleted branch leaves the
 * picker, and a create naming it is refused rather than forked from its last
 * fetched tip. Only the refspec's destination is pruned: worktree branches
 * are local `agent/*` heads, and the symbolic `origin/HEAD` is kept. The URL is
 * the project row's, passed in: the repository's own `remote.origin.*` is
 * written by pods, so it never decides where a fetch goes, what it runs, or
 * where a token is sent.
 *
 * Fetches of one repo run one at a time, and coalesce: a caller that arrives
 * while one is running joins the fetch queued behind it rather than queueing
 * its own. That one starts after every caller joining it asked, so each
 * still sees the remote as of its request, and a burst of callers costs two
 * fetches rather than one per caller.
 */
export function fetchOrigin(
  repoPath: string,
  remoteUrl: string,
  credential: ResolvedGitCredential | null,
): Promise<void> {
  const queued = queuedFetches.get(repoPath)
  if (queued) return queued
  const run = fetchOriginMutex(repoPath, async () => {
    // Started: a caller from here on needs a fetch that starts after it.
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
 * The main clone's one gc, run by the server after its fetches
 * (docs/server-git.md). Every worktree clone borrows objects from the main
 * clone through `objects/info/alternates`, and the main clone cannot see
 * which: their refs, indexes and reflogs are in their own git dirs. So an
 * object the main clone holds is never deleted — unreachable ones are kept
 * in a cruft pack — and the pins that say so are on the command line, where
 * they beat anything in the config. A `--prune` flag would beat them in
 * turn, which is why this never passes one.
 *
 * Under the fetch's mutex, so it never races a fetch writing the packs it
 * repacks; `gc.auto` is git's own default, overriding the runner's pin
 * that stops every other call from starting a gc.
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
 * The newest record of a fetch into `origin/<branch>`, in the main clone or
 * in the checkout whose git dir is `checkoutGitDir`. No one file holds it:
 * the server's own fetches run in a throwaway git dir whose FETCH_HEAD is
 * deleted with it, so each records itself (`fetchRecord`); a fetch that
 * moved the branch appends to its reflog, in the main clone or in the
 * checkout the origin refresh or the agent moved it in; and a fetch the agent
 * ran itself leaves the checkout's FETCH_HEAD. The files are read only for
 * their mtimes, through lstat, so a planted symlink leads nowhere.
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

/** The never-prune keys, for the main clone's real config: git that runs
 *  there without the server's pins reads them (`cloneRepo`,
 *  `ensureNeverPrune`). */
export const NEVER_PRUNE_KEYS = ['gc.pruneExpire', 'gc.reflogExpire', 'gc.reflogExpireUnreachable']

/**
 * Write the never-prune keys into the main clone's REAL config while a
 * linked checkout is left in it (docs/legacy-compat-shims.md). A legacy
 * pod still mounts that `.git` read-write and auto-gcs it with its own git,
 * which reads this file and sees none of the clones' refs: with git's
 * default two-week prune expiry it would, weeks later, delete objects a
 * clone borrows. Nothing to do once `worktrees/` is gone, since no pod can
 * write the main clone then. Written only when a key is missing, because a
 * host-side write replaces the file's inode under the cache legacy pods read
 * it through.
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

/** Where a checkout's git dir is assembled before it is moved into place:
 *  beside the checkout, where no workspace mounts it. */
export function stagingGitDir(worktreePath: string): string {
  return path.join(path.dirname(worktreePath), `.staging-${path.basename(worktreePath)}`, '.git')
}

/**
 * Lay out a new, empty clone of the main clone at `gitDir`: its own config
 * naming the project row's URL as `origin` and `branch`'s upstream, and an
 * alternates line borrowing every object from the main clone. `refs` are
 * `<sha> <refname>` lines, written as `packed-refs` so a repository with
 * thousands of branches does not cost thousands of files per worktree.
 *
 * The alternates line is the main clone's objects dir as the SERVER sees it:
 * a pod mounts the main clone at that same path (docs/server-git.md), so one
 * line is true in every view.
 */
export async function initClone(repoPath: string, gitDir: string, params: {
  remoteUrl: string
  branch: string
  baseBranch: string | null
  refs: string[]
  originHead: string | null
}): Promise<void> {
  if (await fs.lstat(path.join(repoPath, '.git', 'shallow')).then(() => true, () => false)) {
    throw new Error(`${repoPath} is a shallow clone, which a worktree cannot borrow from`)
  }
  const format = (await runGit(repo(repoPath), ['rev-parse', '--show-object-format'])).trim()
  // No template: no sample hooks, no `info/exclude` — nothing the server
  // did not choose.
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

/** `<sha> <refname>` for every ref of the main clone under `prefixes`, and
 *  the target of its `origin/HEAD`, which is listed separately because it
 *  is symbolic. */
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
 * Create a worktree's checkout at a path that may ALREADY EXIST and already
 * hold entries — a worktree's `/workspace` mount points (the ephemeral module
 * dirs) are created there before the checkout runs, and the pod's runtime
 * creates any that are missing the moment it mounts.
 *
 * The checkout is a clone of its own (docs/server-git.md): a full `.git`
 * directory holding a snapshot of the main clone's `origin/*` and tags,
 * `branch` at `origin/<baseBranch>` with that as its upstream, and no object
 * of its own — every one is borrowed through `objects/info/alternates`. It
 * is assembled in a staging dir no workspace mounts, populated from there,
 * and only then renamed in as `<worktreePath>/.git`: one new directory
 * entry, so the destination's inode is never replaced, which is what lets
 * the pod bind `/workspace` to it before any of this has run.
 *
 * The checkout is forced because nothing already in the destination can be
 * worth keeping: a destination holding a live checkout has a `.git`, and
 * callers reuse those rather than creating over them, so anything else there
 * is a crashed earlier attempt's half-written tree, which a plain checkout
 * would refuse to overwrite forever. A failure leaves no `.git` behind, so a
 * retry starts over.
 */
export async function createCheckout(repoPath: string, worktreePath: string, params: {
  branch: string
  baseBranch: string
  remoteUrl: string
}): Promise<void> {
  await ensureNeverPrune(repoPath)
  const startSha = await resolveRemoteRef(repoPath, params.baseBranch)
  const gitDir = stagingGitDir(worktreePath)
  await fs.rm(path.dirname(gitDir), { recursive: true, force: true })
  await fs.mkdir(path.dirname(gitDir), { recursive: true })
  try {
    await initClone(repoPath, gitDir, {
      ...params,
      ...await mainRefs(repoPath, ['refs/remotes/origin', 'refs/tags']),
    })
    await runGit({ kind: 'private', gitDir }, ['update-ref', `refs/heads/${params.branch}`, startSha])
    await runGit({ kind: 'private', gitDir }, ['symbolic-ref', 'HEAD', `refs/heads/${params.branch}`])
    await fs.mkdir(worktreePath, { recursive: true })
    await runGit({ kind: 'private', gitDir, workTree: worktreePath }, ['checkout', '--force', '--quiet'])
    await fs.rename(gitDir, path.join(worktreePath, '.git'))
  } finally {
    await fs.rm(path.dirname(gitDir), { recursive: true, force: true })
  }
}
