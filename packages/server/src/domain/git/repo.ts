import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { gitConfigValue } from '@yaac/shared/git'
import { serverLocalPath } from '@yaac/shared/paths'
import type { GitProgress } from '@yaac/shared/types'
import { createKeyedMutex } from '#lib/keyed-mutex'
import { runGit } from './run'
import type { GitTarget } from './run'
import { gitEnvForCredential } from './transport'
import type { ResolvedGitCredential } from './transport'

/**
 * Git operations on a repo's main clone and the checkouts that borrow
 * from it: clone, fetch, gc, branch and tree lookups, and checkout creation.
 * Every call goes through `runGit` (docs/server-git.md). The remote URL
 * always comes from the repo's row, never from the repository.
 */

const repo = (repoPath: string): GitTarget => ({ kind: 'repo', repoPath })

/**
 * Clone `remoteUrl` to `destPath`, reporting git's progress to
 * `onProgress`. Nothing reads a main clone's working tree (every read goes
 * through its `.git`), so none is checked out: on a network filesystem
 * writing one costs tens of milliseconds a file
 * (docs/nfs-checkout-performance.md), which for a large repo dwarfs the
 * download.
 */
export async function cloneRepo(
  remoteUrl: string,
  destPath: string,
  credential: ResolvedGitCredential | null,
  onProgress?: (progress: GitProgress) => void,
): Promise<void> {
  await runGit({ kind: 'none' }, ['clone', '--no-checkout', ...(onProgress ? ['--progress'] : []), remoteUrl, destPath], {
    env: await gitEnvForCredential(credential, remoteUrl),
    remoteUrl,
    onProgress,
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

/** A remote the main clone keeps branches of: its repo's origin, or a
 *  fork's upstream (docs/repo-forks.md). */
export type MainRemote = 'origin' | 'upstream'

/**
 * All of a remote's branch names in the main clone (without the
 * `origin/` prefix), most recently committed first — the order a branch
 * picker wants on top. Excludes the `HEAD` symref.
 */
export async function listRemoteBranches(repoPath: string, remote: MainRemote = 'origin'): Promise<string[]> {
  const out = await runGit(repo(repoPath), [
    'for-each-ref', '--sort=-committerdate', '--format=%(refname:strip=3)', `refs/remotes/${remote}`,
  ])
  return out.split('\n').map((l) => l.trim()).filter((l) => l.length > 0 && l !== 'HEAD')
}

/** The commit `refs/remotes/<remote>/<branch>` names; rejects when absent. */
export async function resolveRemoteRef(repoPath: string, branch: string, remote: MainRemote = 'origin'): Promise<string> {
  return resolveCommit(repoPath, `refs/remotes/${remote}/${branch}`)
}

/** Whether the main clone has `commit`, a full sha, as a commit. */
export async function hasCommit(repoPath: string, commit: string): Promise<boolean> {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) return false
  return resolveCommit(repoPath, commit).then(() => true, () => false)
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

/** Which of `paths` git tracks at `ref`, as a tree or a file, in the order
 *  given. Rejects when `ref` does not resolve. */
export async function listTrackedPaths(repoPath: string, ref: string, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return []
  const out = await runGit(repo(repoPath), ['--literal-pathspecs', 'ls-tree', '-z', '--name-only', ref, '--', ...paths])
  const found = new Set(out.split('\0'))
  return paths.filter((p) => found.has(p))
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
 * ("cannot lock ref 'refs/remotes/origin/<b>'"), which happens when two
 * creates and a branch listing fetch together. Different repos
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
 * Fetch every branch of a fork's upstream at `remoteUrl` into
 * `refs/remotes/upstream/*` (docs/repo-forks.md "Upstreams in server git"),
 * pruned, under the lock origin's fetches take, so the two remotes share
 * one clone and its objects. Tags are left out, since they would land
 * among origin's.
 */
export function fetchUpstream(
  repoPath: string,
  remoteUrl: string,
  credential: ResolvedGitCredential | null,
): Promise<void> {
  return fetchOriginMutex(repoPath, async () => {
    await runGit(repo(repoPath), ['fetch', '--prune', '--no-tags', remoteUrl, '+refs/heads/*:refs/remotes/upstream/*'], {
      env: await gitEnvForCredential(credential, remoteUrl), remoteUrl,
    })
  })
}

/**
 * Set the main clone's `upstream/*` to a copy of `origin/*`, or with
 * `drop` delete every `upstream/*` ref. The objects stay, as everything a
 * main clone ever held does.
 */
export function setUpstreamRefs(repoPath: string, opts: { drop?: boolean } = {}): Promise<void> {
  return fetchOriginMutex(repoPath, async () => {
    const list = async (remote: MainRemote): Promise<string[][]> =>
      (await runGit(repo(repoPath), ['for-each-ref', '--format=%(objectname) %(refname:strip=3)', `refs/remotes/${remote}`]))
        .split('\n').filter((l) => l !== '').map((l) => l.split(' ')).filter(([, name]) => name !== 'HEAD')
    const copies = opts.drop === true ? [] : await list('origin')
    const copied = new Set(copies.map(([, name]) => name))
    const lines = [
      ...(await list('upstream')).filter(([, name]) => !copied.has(name)).map(([, name]) => `delete refs/remotes/upstream/${name}`),
      ...copies.map(([sha, name]) => `update refs/remotes/upstream/${name} ${sha}`),
    ]
    if (lines.length > 0) await runGit(repo(repoPath), ['update-ref', '--stdin'], { input: `${lines.join('\n')}\n` })
  })
}

/**
 * Each branch of the main clone's `origin/*` and `upstream/*`, by name,
 * against the other remote's (docs/repo-forks.md "Moving back to the
 * upstream"): `same` where origin's is the upstream's or behind it, `ahead`
 * where it has the upstream's with commits on top, `diverged` where
 * neither contains the other, or on one side only.
 */
export async function compareRemoteBranches(repoPath: string): Promise<Array<{
  branch: string
  state: 'same' | 'upstream-only' | 'fork-only' | 'ahead' | 'diverged'
}>> {
  const tips = async (remote: MainRemote): Promise<Map<string, string>> => new Map(
    (await runGit(repo(repoPath), ['for-each-ref', '--format=%(refname:strip=3) %(objectname)', `refs/remotes/${remote}`]))
      .split('\n').filter((l) => l !== '').map((l) => l.split(' ') as [string, string]).filter(([name]) => name !== 'HEAD'),
  )
  const [fork, upstream] = await Promise.all([tips('origin'), tips('upstream')])
  const contains = (tip: string, commit: string): Promise<boolean> =>
    runGit(repo(repoPath), ['merge-base', '--is-ancestor', commit, tip]).then(() => true, () => false)
  return Promise.all([...new Set([...fork.keys(), ...upstream.keys()])].sort().map(async (branch) => {
    const mine = fork.get(branch)
    const theirs = upstream.get(branch)
    const state = mine === undefined ? 'upstream-only'
      : theirs === undefined ? 'fork-only'
        : await contains(theirs, mine) ? 'same'
          : await contains(mine, theirs) ? 'ahead' : 'diverged'
    return { branch, state }
  }))
}

/**
 * Give an origin with no branches its first: an empty root commit by
 * `author` on the branch the main clone's HEAD names. A clone of an empty
 * remote takes that from the remote's advertised default where the host
 * advertises one (GitHub does), else from this server's
 * `init.defaultBranch`. Otherwise a workspace's first push would create
 * origin's first branch, which a host such as GitHub makes its default
 * whatever its name. Nothing is forced, and it holds the fetch lock, so of
 * two creates racing on one repo only the first pushes. Emptiness is
 * confirmed against the remote itself before pushing, since the local refs
 * are only current if a fetch just ran. A no-op once origin has a branch.
 */
export function seedEmptyOrigin(
  repoPath: string,
  remoteUrl: string,
  credential: ResolvedGitCredential | null,
  author: { name: string; email: string },
): Promise<void> {
  return fetchOriginMutex(repoPath, async () => {
    if ((await listRemoteBranches(repoPath)).length > 0) return
    const git = (args: string[]): Promise<string> => runGit(repo(repoPath), args).then((out) => out.trim())
    const remote = async (args: string[]): Promise<string> => runGit(repo(repoPath), args, {
      env: await gitEnvForCredential(credential, remoteUrl),
      remoteUrl,
    })
    if ((await remote(['ls-remote', '--heads', remoteUrl])).trim() !== '') return
    const branch = await git(['symbolic-ref', '--short', 'HEAD'])
    const tree = await git(['hash-object', '-w', '-t', 'tree', '/dev/null'])
    const sha = await git([
      '-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`,
      'commit-tree', tree, '-m', 'Initial commit',
    ])
    await remote(['push', '--quiet', remoteUrl, `${sha}:refs/heads/${branch}`])
    await git(['update-ref', `refs/remotes/origin/${branch}`, sha])
    await setOriginHead(repoPath, branch)
  })
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

/**
 * Copy into the main clone at `repoPath` every object another clone of the
 * same remote holds, reachable or not, so nothing a checkout borrowed from
 * the other clone is lost when it is removed (docs/legacy-compat-shims.md
 * "Main clones under the project dir"). Objects are content-addressed, so
 * a file already there is the same one. A pack's index goes last, since
 * git reads a pack once it sees its index.
 */
export function absorbClone(repoPath: string, otherPath: string): Promise<void> {
  return fetchOriginMutex(repoPath, async () => {
    const from = path.join(otherPath, '.git', 'objects')
    const to = path.join(repoPath, '.git', 'objects')
    for (const dir of await fs.readdir(from)) {
      if (dir !== 'pack' && !/^[0-9a-f]{2}$/.test(dir)) continue
      await fs.mkdir(path.join(to, dir), { recursive: true })
      const names = await fs.readdir(path.join(from, dir))
      for (const name of [...names.filter((n) => !n.endsWith('.idx')), ...names.filter((n) => n.endsWith('.idx'))]) {
        await fs.copyFile(path.join(from, dir, name), path.join(to, dir, name), fsConstants.COPYFILE_EXCL)
          .catch((err: unknown) => {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
          })
      }
    }
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
 * When `<remote>/<branch>` was last fetched, into the main clone or the
 * checkout at `checkoutGitDir`. Takes the newest of: the server's own record
 * (`fetchRecord`), the branch's reflog in either repo, and the checkout's
 * FETCH_HEAD (from an agent's own fetch). Files are only lstat'd for mtimes,
 * so a planted symlink is harmless.
 */
export async function lastFetchedAtMs(
  repoPath: string,
  branch: string,
  checkoutGitDir: string,
  remote: MainRemote = 'origin',
): Promise<number | null> {
  const mtimes = await Promise.all([
    path.join(repoPath, '.git', 'logs', 'refs', 'remotes', remote, branch),
    path.join(checkoutGitDir, 'logs', 'refs', 'remotes', remote, branch),
    path.join(checkoutGitDir, 'FETCH_HEAD'),
  ].map((p) => fs.lstat(p).then((st) => st.mtimeMs, () => 0)))
  const recorded = Number(await fs.readFile(fetchRecord(repoPath), 'utf8').catch(() => '0')) || 0
  const newest = Math.max(recorded, ...mtimes)
  return newest > 0 ? newest : null
}

/**
 * Whether `origin/<branch>` was rewritten under a checkout that started at
 * `startCommit` on it and still sits on the old commits: the branch no
 * longer contains the start, and the checkout's merge base with it
 * (`mergeBase`) is older than the start. One that has rebased onto the new
 * branch has a newer merge base, so it is not. Read from the main clone,
 * which holds every commit named.
 */
export async function baseRewritten(repoPath: string, branch: string, startCommit: string, mergeBase: string): Promise<boolean> {
  if (mergeBase === startCommit) return false
  const contains = (tip: string, commit: string): Promise<boolean> =>
    runGit(repo(repoPath), ['merge-base', '--is-ancestor', commit, tip]).then(() => true, () => false)
  return await contains(startCommit, mergeBase) && !await contains(`refs/remotes/origin/${branch}`, startCommit)
}

/** Never-prune keys for the main clone's real config, read by git run there
 *  without the server's pins. */
export const NEVER_PRUNE_KEYS = ['gc.pruneExpire', 'gc.reflogExpire', 'gc.reflogExpireUnreachable']

/** A checkout's copy of the main clone's refs: `origin/*`, tags and a
 *  fork's `upstream/*` as
 *  `[sha, refname]`, and the target of the symbolic `origin/HEAD`. */
interface MainRefs {
  refs: Array<[string, string]>
  originHead: string | null
}

async function mainRefs(repoPath: string, withUpstream: boolean): Promise<MainRefs> {
  const out = await runGit(repo(repoPath), [
    'for-each-ref', '--format=%(objectname) %(refname) %(symref)', 'refs/remotes/origin', 'refs/tags',
    ...(withUpstream ? ['refs/remotes/upstream'] : []),
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

/** How many processes write a checkout's files; a pod's claim
 *  (daemons/streamd/claim.go) sets the same for the workspace's own git.
 *  More than 8 measured no faster. */
const CHECKOUT_WORKERS = 8

/**
 * Create a workspace's checkout at `workspacePath`, which may already exist
 * with entries (mount points for scratch dirs are created first).
 *
 * The checkout is its own clone (docs/server-git.md): a full `.git` with a
 * snapshot of the main clone's `origin/*` and tags, `branch` at `commit`
 * tracking `origin/<baseBranch>` where one is named, and all objects
 * borrowed via alternates. The caller picks the commit; the snapshot is
 * taken after, so its `origin/<baseBranch>` may already be ahead of it. It
 * is built in `staging`, then renamed in as `<workspacePath>/.git`, so the
 * destination's inode never changes and a pod can bind `/workspace` before
 * this runs.
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
 * The tree is written by `CHECKOUT_WORKERS` processes at once, which cuts
 * a large checkout's time about fourfold.
 *
 * With `gitOnly` no tree is written, only the `.git`, with the branch made
 * at the start commit: a k8s workspace's tree is checked out on its node by
 * its tree container (docs/node-local-workspaces.md "Start"). The
 * `.git` is then filled where it stands, an empty folder the caller made
 * before the pod that mounts it was applied, since a mount source must
 * exist by then and a rename would swap it from under the mount.
 */
export async function createCheckout(repoPath: string, workspacePath: string, params: {
  branch: string
  remoteUrl: string
  /** `origin`'s push URL, for a repo workspaces only read. */
  pushUrl?: string
  /** A fork's upstream, as a remote that can only be fetched. */
  upstream?: { url: string; pushUrl: string }
  /** Where the `.git` is assembled: a dir of the caller's that no
   *  workspace mounts, on the checkout's filesystem. */
  staging: string
  commit: string
  baseBranch?: string
  gitOnly?: boolean
}): Promise<void> {
  if (await fs.lstat(path.join(repoPath, '.git', 'shallow')).then(() => true, () => false)) {
    throw new Error(`${repoPath} is a shallow clone, which a workspace cannot borrow from`)
  }
  const { branch, baseBranch, commit, staging } = params
  const main = await mainRefs(repoPath, params.upstream !== undefined)
  const gitDir = params.gitOnly ? path.join(workspacePath, '.git') : path.join(staging, '.git')
  await fs.rm(staging, { recursive: true, force: true })
  await fs.mkdir(staging, { recursive: true })
  if (params.gitOnly) await fs.mkdir(gitDir, { recursive: true })
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
    // A `.git` made where it stands gets its own checkout as its work tree,
    // which git then records nowhere: any other would land in its config
    // as `core.worktree`, a path only the server sees.
    await runGit({ kind: 'private', gitDir, workTree: params.gitOnly ? workspacePath : staging }, [
      '-c', 'init.defaultRefFormat=files',
      'init', '--quiet', '--template=', `--object-format=${format}`,
    ])
    // A checkout at a commit tracks no branch.
    await fs.appendFile(path.join(gitDir, 'config'), [
      '[remote "origin"]',
      `\turl = ${gitConfigValue(params.remoteUrl)}`,
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
      ...(params.pushUrl !== undefined ? [`\tpushurl = ${gitConfigValue(params.pushUrl)}`] : []),
      ...(params.upstream !== undefined
        ? [
          '[remote "upstream"]',
          `\turl = ${gitConfigValue(params.upstream.url)}`,
          '\tfetch = +refs/heads/*:refs/remotes/upstream/*',
          `\tpushurl = ${gitConfigValue(params.upstream.pushUrl)}`,
        ]
        : []),
      ...(baseBranch !== undefined
        ? [`[branch ${gitConfigValue(branch)}]`, '\tremote = origin', `\tmerge = ${gitConfigValue(`refs/heads/${baseBranch}`)}`]
        : []),
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
    // `-B` points the branch at the commit in the same process, with its
    // reflog.
    await (params.gitOnly
      ? runGit({ kind: 'private', gitDir, workTree: staging }, ['update-ref', '-m', `branch: Created from ${commit}`, `refs/heads/${branch}`, commit])
      : runGit({ kind: 'private', gitDir, workTree: workspacePath },
        ['-c', `checkout.workers=${String(CHECKOUT_WORKERS)}`, 'checkout', '--force', '--quiet', '-B', branch, commit]))
    if (!params.gitOnly) await fs.rename(gitDir, path.join(workspacePath, '.git'))
  } finally {
    await fs.rm(staging, { recursive: true, force: true })
  }
}

/**
 * Make sure the main clone has `sha`, a full commit id, fetching it from
 * origin by id if it does not: GitHub serves any commit reachable from one
 * of its refs, a fork's PR head included. Refuses one origin cannot serve.
 * The fetched commit is kept, unreferenced, like everything the main clone
 * ever had (`maintainRepo` never prunes).
 */
export async function fetchCommit(
  repoPath: string,
  remoteUrl: string,
  credential: ResolvedGitCredential | null,
  sha: string,
): Promise<void> {
  const has = (): Promise<boolean> => runGit(repo(repoPath), ['cat-file', '-e', `${sha}^{commit}`]).then(() => true, () => false)
  if (await has()) return
  await fetchOriginMutex(repoPath, async () => {
    await runGit(repo(repoPath), ['fetch', '--no-tags', remoteUrl, sha], {
      env: await gitEnvForCredential(credential, remoteUrl), remoteUrl,
    }).catch(() => { /* reported below */ })
  })
  if (!await has()) throw new Error(`origin has no commit ${sha}`)
}
