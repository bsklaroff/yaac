import fs from 'node:fs/promises'
import path from 'node:path'
import { createKeyedMutex } from '#lib/keyed-mutex'
import { readRepoConfig, runGit } from './run'
import type { GitTarget } from './run'
import { gitEnvForCredential, injectTokenIntoUrl, torEnv } from './transport'
import type { ResolvedGitCredential } from './transport'
import type { FileStatus } from '@yaac/shared/types'

/**
 * Git operations against a project's clone and the worktrees cut from it —
 * clone, fetch, branch and tree lookups, worktree add and its rollback.
 *
 * The process boundary for domain the way kubectl is the driver's: every
 * git process the server starts is one of these, and each runs through
 * `runGit`, which never lets git read the pod-writable config
 * (docs/server-git.md). A remote URL is always the caller's — the project
 * row's — and never read back out of the repository.
 */

const repo = (repoPath: string): GitTarget => ({ kind: 'repo', repoPath })

export async function cloneRepo(
  remoteUrl: string,
  destPath: string,
  credential: ResolvedGitCredential | null,
): Promise<void> {
  if (credential?.kind === 'https') {
    const authedUrl = injectTokenIntoUrl(remoteUrl, credential.token)
    await runGit({ kind: 'none' }, ['clone', authedUrl, destPath], { env: torEnv(), remoteUrl })
    // Strip credentials from the stored remote URL. Written to the real
    // config — the one pods' git reads — before any pod can exist.
    await runGit({ kind: 'none' }, [
      'config', '--file', path.join(destPath, '.git', 'config'), 'remote.origin.url', remoteUrl,
    ])
    return
  }
  // SSH signs through the in-process agent; no credential is an
  // unauthenticated clone (works for public HTTPS repos).
  await runGit({ kind: 'none' }, ['clone', remoteUrl, destPath], {
    env: await gitEnvForCredential(credential),
    remoteUrl,
  })
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

/**
 * The branch a worktree branch tracks, read from the repo's config
 * (`branch.<name>.merge` = `refs/heads/<branch>`), or null when no
 * upstream is recorded. For worktree branches (`agent/<worktreeId>`) this is
 * the durable record of the reference branch the worktree was created from:
 * `launchWithSetup` writes it before the tmux session exists, and the
 * claim-time re-branch prep rewrites it.
 */
export async function worktreeUpstreamBranch(repoPath: string, branchName: string): Promise<string | null> {
  const merge = (await readRepoConfig(repoPath, `branch.${branchName}.merge`).catch(() => [])).at(-1)
  // Pod-written data: only a plain branch name comes back out.
  const match = merge?.match(/^refs\/heads\/([^\s~^:?*[\\]+)$/)
  return match ? match[1] : null
}

/** The commit `refs/remotes/origin/<branch>` names; rejects when absent. */
export async function resolveRemoteRef(repoPath: string, branch: string): Promise<string> {
  return (await runGit(repo(repoPath), [
    'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}^{commit}`,
  ])).trim()
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

/**
 * Fetch every branch of `remoteUrl` into `refs/remotes/origin/*`. The URL is
 * the project row's, passed in: the repository's own `remote.origin.*` is
 * written by pods, so it never decides where a fetch goes, what it runs, or
 * where a token is sent.
 */
export async function fetchOrigin(
  repoPath: string,
  remoteUrl: string,
  credential: ResolvedGitCredential | null,
): Promise<void> {
  const url = credential?.kind === 'https' ? injectTokenIntoUrl(remoteUrl, credential.token) : remoteUrl
  const env = credential?.kind === 'https' ? torEnv() : await gitEnvForCredential(credential)
  await fetchOriginMutex(repoPath, async () => {
    await runGit(repo(repoPath), [
      'fetch', url, '+refs/heads/*:refs/remotes/origin/*', '--update-head-ok',
    ], { env, remoteUrl })
  })
}

/** Run a rollback step, keeping the failure that triggered it as the one
 *  the caller sees. */
async function bestEffort(op: () => Promise<unknown>): Promise<void> {
  try {
    await op()
  } catch {
    // The original error is the one worth reporting.
  }
}

/**
 * Add a worktree worktree at a path that may ALREADY EXIST and already hold
 * entries — a worktree's `/workspace` mount points (the ephemeral module
 * dirs) are created there before the checkout runs, and the pod's runtime
 * creates any that are missing the moment it mounts. `git worktree add`
 * refuses a destination that is not an empty directory (`--force` does not
 * relax that check), so the checkout is staged: the worktree is created
 * `--no-checkout` in a scratch dir — where only its `.git` file lands — a
 * `.git` file naming the admin dir is written into the real destination,
 * the admin `gitdir` is pointed back at it, and the population happens in
 * place. The
 * destination's inode is never replaced, which is what lets the pod bind
 * `/workspace` to it before any of this has run.
 *
 * The scratch dir's basename is the destination's, because git names the
 * admin dir (`.git/worktrees/<name>`) after it and the in-pod relink
 * addresses that dir by worktree id.
 *
 * Staging moves the branch's creation ahead of the steps that can fail, so
 * every failure after it is rolled back here: a create that dies is a
 * `never-started` worktree, and restarting one resumes the SAME id and calls
 * this again with the same branch name. Left behind, the registration and
 * the branch make that retry die on "a branch named … already exists" —
 * and the registration has to go first, because git refuses to delete a
 * branch a registration still claims.
 *
 * `--no-track` is deliberate: setting up branch tracking here would write
 * the shared `.git/config` from the host, and a host-side write replaces
 * the file's inode underneath the VM-kernel virtiofs cache that worktree
 * pods read `/repo/.git` through — until the stale dentry expires (a few
 * seconds), every git command in a pod dies with "fatal: unknown error
 * occurred while reading the configuration files". The upstream is
 * configured from inside the pod instead (see `launchWithSetup`), where
 * the write stays cache-coherent for all pods and the host alike. With no
 * config write left here, concurrent adds no longer race git's config.lock
 * and need no serialization.
 */
export async function addWorktree(repoPath: string, worktreePath: string, branchName: string, startPoint?: string): Promise<void> {
  const base = path.basename(worktreePath)
  const stagingRoot = path.join(path.dirname(worktreePath), `.staging-${base}`)
  const staged = path.join(stagingRoot, base)
  await fs.rm(stagingRoot, { recursive: true, force: true })
  await fs.mkdir(stagingRoot, { recursive: true })
  try {
    const args = ['worktree', 'add', '--no-track', '--no-checkout', staged, '-b', branchName]
    if (startPoint) args.push(startPoint)
    await runGit(repo(repoPath), args)
    let adminDir: string | undefined
    let wroteGit = false
    try {
      // The staged `.git` names the admin dir git just registered, and is
      // the only thing that knows its name once the scratch dir is gone.
      // Only the name: git reached the admin dir through the throwaway git
      // dir `runGit` built, so the path it wrote is that one's.
      const adminName = path.basename((await fs.readFile(path.join(staged, '.git'), 'utf8'))
        .replace(/^gitdir:/, '').trim())
      adminDir = path.join(repoPath, '.git', 'worktrees', adminName)
      await fs.mkdir(worktreePath, { recursive: true })
      await fs.writeFile(path.join(worktreePath, '.git'), `gitdir: ${adminDir}\n`)
      wroteGit = true
      // Point the admin dir back at where the worktree actually is. The
      // `.git` above already names the admin dir, so this one line is the
      // whole of the repair — and it is written directly rather than with
      // `git worktree repair`, which is NOT scoped to the path it is given:
      // it walks every worktree registered in the repo and, for any whose
      // `gitdir` no longer resolves, writes a fresh `.git` file at whatever
      // path that file names.
      //
      // Every worktree last started under k8s has exactly such a `gitdir`,
      // because its launch rewrites it to the container's own view
      // (`/workspace/.git`, see buildWorktreeLinkExec). So a repair run
      // anywhere that /workspace is a real directory — a nested yaac, or an
      // e2e suite inside a worktree, both supported — resolves those pod
      // paths in the CURRENT namespace and overwrites the live worktree
      // sitting there, pointing it at an unrelated repo's admin dir.
      await fs.writeFile(path.join(adminDir, 'gitdir'), `${worktreePath}/.git\n`)
      // `--no-checkout` leaves the index empty, so a bare `checkout` (the
      // documented way to finish a deferred worktree add) populates the
      // tree. Forced because an empty index treats everything already in
      // the destination as untracked, and a plain checkout refuses to
      // overwrite such a file even when it is byte-identical: a crashed
      // earlier attempt's half-written tree would wedge the retry forever.
      // Nothing there can be worth keeping — a destination holding a live
      // checkout has a `.git` file, and callers reuse those rather than
      // adding over them.
      await runGit({ kind: 'worktree', repoPath, worktreeId: adminName, workTree: worktreePath }, [
        'checkout', '--force',
      ])
    } catch (err) {
      // Deliberately not `git worktree prune`: it would also drop a
      // CONCURRENT add whose registration momentarily points at its own
      // scratch dir, between that add's rename and its repair.
      const admin = adminDir
      if (admin !== undefined) await bestEffort(() => fs.rm(admin, { recursive: true, force: true }))
      // `update-ref`, not `branch -D`, which would also rewrite the config.
      await bestEffort(() => runGit(repo(repoPath), ['update-ref', '-d', `refs/heads/${branchName}`]))
      // Only ours: a `.git` this call did not stage belongs to whatever
      // put it there. Leaving one behind would make the destination pass
      // the caller's "already a worktree" probe with an empty index, where
      // git reports every tracked file deleted.
      if (wroteGit) await bestEffort(() => fs.rm(path.join(worktreePath, '.git'), { force: true }))
      throw err
    }
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true })
  }
}

/** What `listCheckoutFiles` reads off a worktree's checkout. */
export interface CheckoutListing {
  /** Tracked and untracked files, gitignore-aware, minus those deleted from
   *  disk. */
  paths: string[]
  /** Ignored files, and each wholly ignored folder as one `dir/` entry. */
  ignored: string[]
  /** Untracked folders, each collapsed to one entry without its trailing
   *  slash — the only record git keeps of a folder holding no file. */
  untrackedDirs: string[]
  status: Record<string, FileStatus>
}

/**
 * The file list of a worktree's checkout, read from the server's own view of
 * it.
 *
 * A `worktree` target names the admin dir, the shared repo and the work tree
 * explicitly, which this needs: the checkout's `.git` file names the admin
 * dir as the substrate that last launched it sees it — under k8s the POD's
 * `/repo/.git/worktrees/<id>` (see buildWorktreeLinkExec), which means
 * nothing here. `status` skips submodules
 * outright, flag and all, because a `.gitmodules` `ignore` entry would
 * otherwise beat the runner's pin and send git into a pod-written git dir.
 *
 * Nothing here writes. `ls-files` never does, and `status` runs with
 * `--no-optional-locks` so its opportunistic index refresh is never written
 * back: a write to the worktree's index from outside the pod is a lock the
 * in-pod git can collide with, and a replaced inode under the VM's cached
 * view (see `addWorktree`'s `--no-track` note). Comparing only mtime and
 * size keeps a clean file clean even though in-pod git wrote the index's
 * stat data through a different mount, where inode and device numbers need
 * not match.
 */
export async function listCheckoutFiles(
  repoPath: string,
  worktreeId: string,
  worktreePath: string,
): Promise<CheckoutListing> {
  const target: GitTarget = { kind: 'worktree', repoPath, worktreeId, workTree: worktreePath }
  const run = async (args: string[]): Promise<string[]> =>
    (await runGit(target, args)).split('\0').filter((p) => p !== '')
  const [listed, deleted, ignored, untrackedDirs, status] = await Promise.all([
    run(['ls-files', '-z', '--cached', '--others', '--exclude-standard']),
    run(['ls-files', '-z', '--deleted']),
    run(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']),
    run(['ls-files', '-z', '--others', '--exclude-standard', '--directory']),
    run([
      '-c', 'core.checkStat=minimal', '-c', 'core.trustctime=false', '--no-optional-locks',
      'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all',
    ]),
  ])
  const gone = new Set(deleted)
  return {
    // A file both tracked and modified is listed once per index stage when
    // conflicted, so the list is deduplicated too.
    paths: [...new Set(listed)].filter((p) => !gone.has(p)),
    ignored,
    untrackedDirs: untrackedDirs.filter((p) => p.endsWith('/')).map((p) => p.slice(0, -1)),
    status: parsePorcelainStatus(status),
  }
}

/**
 * Map `status --porcelain=v1 -z` entries to one `FileStatus` per path.
 * Staged and unstaged are not told apart, and a deletion is dropped: the
 * explorer only colors files that exist.
 */
function parsePorcelainStatus(entries: string[]): Record<string, FileStatus> {
  const out: Record<string, FileStatus> = {}
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const [x, y, file] = [entry[0], entry[1], entry.slice(3)]
    // A rename or copy is followed by its source path as its own entry.
    if (x === 'R' || x === 'C') i++
    if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) out[file] = 'conflicted'
    else if (x === '?') out[file] = 'untracked'
    else if (y === 'D') continue
    else if (x === 'A' || x === 'R' || x === 'C' || y === 'A') out[file] = 'added'
    else if (x === 'M' || y === 'M' || x === 'T' || y === 'T') out[file] = 'modified'
  }
  return out
}
