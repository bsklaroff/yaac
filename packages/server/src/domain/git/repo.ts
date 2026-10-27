import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { gitConfigValue } from '@yaac/shared/git'
import { serverLocalPath } from '@yaac/shared/paths'
import { createKeyedMutex } from '#lib/keyed-mutex'
import { runGit } from './run'
import type { GitTarget } from './run'
import { gitEnvForCredential } from './transport'
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
  await runGit({ kind: 'none' }, ['clone', remoteUrl, destPath], {
    env: await gitEnvForCredential(credential, remoteUrl),
    remoteUrl,
  })
  const config = path.join(destPath, '.git', 'config')
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
    // Fallback: origin/HEAD is unset in local-only repos and clones of an
    // empty remote, whose HEAD is a branch with no commits yet.
  }
  return (await runGit(repo(repoPath), ['symbolic-ref', '--short', 'HEAD'])).trim()
}

/**
 * Point the main clone's `origin/HEAD` at `origin/<branch>`, which
 * `getDefaultBranch` reads. A clone sets it from the remote, but a clone of
 * an empty remote cannot, so a hosted remote's default is copied in after
 * each push (docs/hosted-projects.md).
 */
export async function setOriginHead(repoPath: string, branch: string): Promise<void> {
  await runGit(repo(repoPath), ['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${branch}`])
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
 * `lastFetchedAtMs`). Written only once a fetch succeeds: git empties
 * FETCH_HEAD before it connects, so its mtime moves on a failed fetch too.
 */
function fetchRecord(repoPath: string): string {
  return serverLocalPath('git-fetched', createHash('sha256').update(repoPath).digest('hex').slice(0, 32))
}

/**
 * Fetch every branch of `remoteUrl` into `refs/remotes/origin/*`, pruning
 * branches origin deleted, so a deleted branch leaves the picker and a create
 * naming it is refused. Only that refspec is pruned; local `agent/*` heads
 * and `origin/HEAD` are kept. The URL comes from the project row, never the
 * repository's own `remote.origin.*`.
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
    await runGit(repo(repoPath), [
      'fetch', '--prune', remoteUrl, '+refs/heads/*:refs/remotes/origin/*', '--update-head-ok',
    ], { env: await gitEnvForCredential(credential, remoteUrl), remoteUrl })
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
    await runGit(repo(repoPath), NEVER_PRUNE_GC)
  })
}

/** `gc --auto` that never deletes an object; see `maintainRepo`. */
export const NEVER_PRUNE_GC = [
  '-c', 'gc.auto=6700',
  '-c', 'gc.autoDetach=false',
  '-c', 'gc.pruneExpire=never',
  '-c', 'gc.reflogExpire=never',
  '-c', 'gc.reflogExpireUnreachable=never',
  '-c', 'gc.worktreePruneExpire=never',
  'gc', '--auto', '--quiet',
]

/**
 * When `origin/<branch>` was last fetched, into the main clone or the
 * checkout at `checkoutGitDir`. Takes the newest of: the server's own record
 * (`fetchRecord`), the branch's reflog in either repo, and the checkout's
 * FETCH_HEAD (from an agent's own fetch). Files are only lstat'd for mtimes,
 * so a planted symlink is harmless.
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
 *  without the server's pins. */
export const NEVER_PRUNE_KEYS = ['gc.pruneExpire', 'gc.reflogExpire', 'gc.reflogExpireUnreachable']

/** A checkout's copy of the main clone's refs: `origin/*` and tags as
 *  `[sha, refname]`, and the target of the symbolic `origin/HEAD`. */
interface MainRefs {
  refs: Array<[string, string]>
  originHead: string | null
}

async function mainRefs(repoPath: string): Promise<MainRefs> {
  const out = await runGit(repo(repoPath), [
    'for-each-ref', '--format=%(objectname) %(refname) %(symref)', 'refs/remotes/origin', 'refs/tags',
  ])
  const refs: Array<[string, string]> = []
  let originHead: string | null = null
  for (const line of out.split('\n')) {
    const [sha, ref, symref] = line.split(' ')
    if (!sha || !ref) continue
    if (symref) {
      if (ref === 'refs/remotes/origin/HEAD') originHead = symref
      continue
    }
    refs.push([sha, ref])
  }
  return { refs, originHead }
}

function remoteSha(main: MainRefs, branch: string): string | undefined {
  return main.refs.find(([, ref]) => ref === `refs/remotes/origin/${branch}`)?.[0]
}

/**
 * Write a staged checkout's copy of the main clone's refs as `packed-refs`
 * (thousands of loose files per workspace otherwise), and `origin/HEAD` as
 * the one-line symbolic ref git would write.
 */
async function writeCheckoutRefs(gitDir: string, main: MainRefs): Promise<void> {
  await fs.writeFile(path.join(gitDir, 'packed-refs'), main.refs.map(([s, ref]) => `${s} ${ref}\n`).join(''))
  const originHead = path.join(gitDir, 'refs', 'remotes', 'origin', 'HEAD')
  if (main.originHead === null) {
    await fs.rm(originHead, { force: true })
  } else {
    await fs.mkdir(path.dirname(originHead), { recursive: true })
    await fs.writeFile(originHead, `ref: ${main.originHead}\n`)
  }
}

/** How many processes write a checkout's files; workspace-bin/yaac-workspace-init
 *  sets the same for the workspace's own git. More than 8 measured no faster. */
const CHECKOUT_WORKERS = 8

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
 * When origin has no branches at all (an empty repo), `branch` is left
 * unborn, so the agent's first commit starts the history.
 *
 * `fetched`, a fetch of the main clone in flight, lets the checkout start
 * from the refs the main clone already has instead of waiting on the
 * network. The result still reflects the refs after the fetch: once it
 * settles, the staged refs are rewritten if any moved, and the tree is
 * updated if the base did. A rejected fetch fails the checkout.
 *
 * The checkout is forced: callers reuse a destination that already has a
 * `.git`, so anything else there is a crashed attempt's partial tree. A
 * failure leaves no `.git`, so a retry starts over.
 *
 * Its `info/exclude` hides `.claude/worktrees`, where claude puts the
 * worktrees it makes, so they do not show as nested repos in the changes
 * list and explorer. It also hides `.nfs*`, the files an NFS client renames
 * a deleted but still-open file to (a byo checkout is on NFS), so an agent's
 * `git add -A` cannot commit them. A project's `.gitignore` can re-include
 * either with a `!` pattern.
 *
 * The tree is written by `CHECKOUT_WORKERS` processes at once. Each file
 * on the shared tier costs a few network round trips, so overlapping them
 * cuts a large checkout's time about fourfold
 * (docs/nfs-checkout-performance.md).
 */
export async function createCheckout(repoPath: string, workspacePath: string, params: {
  branch: string
  baseBranch: string
  remoteUrl: string
  fetched?: Promise<void>
}): Promise<void> {
  // Awaited after the checkout; until then nothing would observe a rejection.
  params.fetched?.catch(() => { /* observed below */ })
  if (await fs.lstat(path.join(repoPath, '.git', 'shallow')).then(() => true, () => false)) {
    throw new Error(`${repoPath} is a shallow clone, which a workspace cannot borrow from`)
  }
  const { branch, baseBranch } = params
  let fetched = params.fetched
  let main = await mainRefs(repoPath)
  // A branch the fetch has yet to bring in cannot be checked out early.
  if (fetched !== undefined && remoteSha(main, baseBranch) === undefined) {
    await fetched
    fetched = undefined
    main = await mainRefs(repoPath)
  }
  const startSha = remoteSha(main, baseBranch) ?? null
  if (startSha === null && main.refs.some(([, ref]) => ref.startsWith('refs/remotes/origin/'))) {
    throw new Error(`origin/${baseBranch} does not exist in ${repoPath}`)
  }
  // Assembled beside the checkout, where no workspace mounts it.
  const staging = path.join(path.dirname(workspacePath), `.staging-${path.basename(workspacePath)}`)
  const gitDir = path.join(staging, '.git')
  await fs.rm(staging, { recursive: true, force: true })
  await fs.mkdir(staging, { recursive: true })
  try {
    // The hash length names the object format; only a repo with no refs
    // has to ask.
    const anySha = main.refs[0]?.[0]
    const format = anySha !== undefined
      ? (anySha.length === 64 ? 'sha256' : 'sha1')
      : (await runGit(repo(repoPath), ['rev-parse', '--show-object-format'])).trim()
    // git init, not a hand-written dir: it probes the filesystem for
    // settings such as macOS's `core.ignorecase`. Non-bare, with the staging
    // dir as its work tree, so its own `[core]` is the checkout's. The files
    // ref format is pinned over a user's default, since a reftable repo would
    // ignore the refs written below (`gitEnv` drops the variable that would
    // beat the pin). No template, so no sample hooks.
    await runGit({ kind: 'private', gitDir, workTree: staging }, [
      '-c', 'init.defaultRefFormat=files',
      'init', '--quiet', '--template=', `--object-format=${format}`,
    ])
    await fs.appendFile(path.join(gitDir, 'config'), [
      '[remote "origin"]',
      `\turl = ${gitConfigValue(params.remoteUrl)}`,
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
      `[branch ${gitConfigValue(branch)}]`,
      '\tremote = origin',
      `\tmerge = ${gitConfigValue(`refs/heads/${baseBranch}`)}`,
      '',
    ].join('\n'))
    await fs.writeFile(path.join(gitDir, 'HEAD'), `ref: refs/heads/${branch}\n`)
    // The alternates path is the server's; a pod mounts the main clone at
    // the same path, so it resolves everywhere.
    await fs.mkdir(path.join(gitDir, 'objects', 'info'), { recursive: true })
    await fs.writeFile(path.join(gitDir, 'objects', 'info', 'alternates'), `${path.join(repoPath, '.git', 'objects')}\n`)
    await fs.mkdir(path.join(gitDir, 'info'))
    await fs.writeFile(path.join(gitDir, 'info', 'exclude'), '/.claude/worktrees/\n.nfs*\n')
    await writeCheckoutRefs(gitDir, main)
    await fs.mkdir(workspacePath, { recursive: true })
    // `-B` points the branch at `sha` in the same process, with its reflog.
    const checkOut = (sha: string): Promise<string> => runGit({ kind: 'private', gitDir, workTree: workspacePath },
      ['-c', `checkout.workers=${String(CHECKOUT_WORKERS)}`, 'checkout', '--force', '--quiet', '-B', branch, sha])
    if (startSha !== null) await checkOut(startSha)
    // Checked out alongside the fetch; catch up with whatever it moved
    // before the checkout becomes visible.
    if (fetched !== undefined) {
      await fetched
      const after = await mainRefs(repoPath)
      if (JSON.stringify(after) !== JSON.stringify(main)) {
        const sha = remoteSha(after, baseBranch)
        if (sha === undefined) throw new Error(`origin/${baseBranch} was deleted on origin`)
        await writeCheckoutRefs(gitDir, after)
        // The index still holds the old tree, so only changed files are
        // written, and files the new tree drops are deleted.
        if (sha !== startSha) await checkOut(sha)
      }
    }
    await fs.rename(gitDir, path.join(workspacePath, '.git'))
  } finally {
    await fs.rm(staging, { recursive: true, force: true })
  }
}
