import fs from 'node:fs/promises'
import path from 'node:path'
import simpleGit from 'simple-git'
import { createKeyedMutex } from '#lib/keyed-mutex'
import { gitEnvForCredential, injectTokenIntoUrl, torEnv } from './transport'
import type { ResolvedGitCredential } from './transport'
import type { FileStatus } from '@yaac/shared/types'

/**
 * Git operations against a project's clone and the worktrees cut from it —
 * clone, fetch, branch lookups, worktree add and its rollback.
 *
 * The process boundary for domain the way kubectl is the driver's. Every git
 * invocation that carries a CREDENTIAL goes through here; the two plain reads
 * still done elsewhere in domain are named in this folder's barrel.
 */

function gitWithCredentialEnv(
  baseDir: string | undefined,
  env: NodeJS.ProcessEnv | undefined,
): ReturnType<typeof simpleGit> {
  const git = baseDir ? simpleGit(baseDir) : simpleGit()
  return env ? git.env(env) : git
}

export async function cloneRepo(
  remoteUrl: string,
  destPath: string,
  credential: ResolvedGitCredential | null,
): Promise<void> {
  if (credential?.kind === 'https') {
    const authedUrl = injectTokenIntoUrl(remoteUrl, credential.token)
    await gitWithCredentialEnv(undefined, torEnv()).clone(authedUrl, destPath)
    // Strip credentials from the stored remote URL.
    await simpleGit(destPath).remote(['set-url', 'origin', remoteUrl])
    return
  }
  // SSH signs through the in-process agent; no credential is an
  // unauthenticated clone (works for public HTTPS repos).
  await gitWithCredentialEnv(undefined, await gitEnvForCredential(credential)).clone(remoteUrl, destPath)
}

/**
 * The clone's `origin` URL — the remote every credential lookup, fetch and
 * proxy registration is resolved against.
 *
 * Rejects when there is no origin: `get-url` either prints the URL or exits
 * non-zero, and simple-git turns the latter into a rejection. The `?? ''`
 * below is there for simple-git's `string | void` return type, NOT for an
 * unset remote — so a caller's falsy check on the result is a belt-and-braces
 * guard rather than the path an origin-less repo takes.
 */
export async function originRemoteUrl(repoPath: string): Promise<string> {
  return (await simpleGit(repoPath).remote(['get-url', 'origin']))?.trim() ?? ''
}

export async function getDefaultBranch(repoPath: string): Promise<string> {
  const git = simpleGit(repoPath)
  try {
    const ref = await git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD'])
    const match = ref.trim().match(/^refs\/remotes\/origin\/(.+)$/)
    if (match) return match[1]
  } catch {
    // Fallback: origin/HEAD may not be set (e.g. local-only repos)
  }
  const branch = await git.revparse(['--abbrev-ref', 'HEAD'])
  return branch.trim()
}

/** True when `refs/remotes/origin/<branch>` exists in the repo. */
export async function remoteBranchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    // --quiet suppresses stderr, and simple-git then resolves the exit-1
    // miss with empty output instead of rejecting — so key on the output
    // (a hit prints the SHA), keeping the catch for non-repo errors.
    const out = await simpleGit(repoPath).raw(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])
    return out.trim().length > 0
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
  const out = await simpleGit(repoPath).raw([
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
  let merge: string
  try {
    merge = await simpleGit(repoPath).raw(['config', '--get', `branch.${branchName}.merge`])
  } catch {
    return null // unset — git config --get exits 1
  }
  const match = merge.trim().match(/^refs\/heads\/(.+)$/)
  return match ? match[1] : null
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

export async function fetchOrigin(
  repoPath: string,
  credential: ResolvedGitCredential | null,
): Promise<void> {
  await fetchOriginMutex(repoPath, async () => {
    if (credential?.kind === 'https') {
      const git = gitWithCredentialEnv(repoPath, torEnv())
      // This one goes through the credential-carrying handle, not
      // `originRemoteUrl`: the fetch needs the same env the URL is read with.
      const remoteUrl = (await git.remote(['get-url', 'origin']))!.trim()
      const authedUrl = injectTokenIntoUrl(remoteUrl, credential.token)
      await git.raw(['fetch', authedUrl, '+refs/heads/*:refs/remotes/origin/*', '--update-head-ok'])
      return
    }
    await gitWithCredentialEnv(repoPath, await gitEnvForCredential(credential)).fetch('origin')
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
 * `--no-checkout` in a scratch dir — where only its `.git` file lands — that
 * file is moved into the real destination, `worktree repair` re-points the
 * admin `gitdir` at it, and the population happens in place. The
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
    await simpleGit(repoPath).raw(args)
    let adminDir: string | undefined
    let movedGit = false
    try {
      // The staged `.git` names the admin dir git just registered, and is
      // the only thing that knows it once the scratch dir is gone.
      adminDir = (await fs.readFile(path.join(staged, '.git'), 'utf8'))
        .replace(/^gitdir:/, '').trim()
      await fs.mkdir(worktreePath, { recursive: true })
      await fs.rename(path.join(staged, '.git'), path.join(worktreePath, '.git'))
      movedGit = true
      // Point the admin dir back at where the worktree actually is. The
      // moved `.git` already names the admin dir, so this one line is the
      // whole of the repair — and it is written directly rather than with
      // `git worktree repair`, which is NOT scoped to the path it is given:
      // it walks every worktree registered in the repo and, for any whose
      // `gitdir` no longer resolves, writes a fresh `.git` file at whatever
      // path that file names.
      //
      // Every worktree yaac has ever started has exactly such a `gitdir`,
      // because the in-pod setup rewrites it to the container's own view
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
      await simpleGit(worktreePath).raw(['checkout', '--force'])
    } catch (err) {
      // Deliberately not `git worktree prune`: it would also drop a
      // CONCURRENT add whose registration momentarily points at its own
      // scratch dir, between that add's rename and its repair.
      const admin = adminDir
      if (admin !== undefined) await bestEffort(() => fs.rm(admin, { recursive: true, force: true }))
      await bestEffort(() => simpleGit(repoPath).raw(['branch', '-D', branchName]))
      // Only ours: a `.git` this call did not stage belongs to whatever
      // put it there. Leaving one behind would make the destination pass
      // the caller's "already a worktree" probe with an empty index, where
      // git reports every tracked file deleted.
      if (movedGit) await bestEffort(() => fs.rm(path.join(worktreePath, '.git'), { force: true }))
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
 * Both halves are named explicitly because the checkout's `.git` file names
 * the admin dir as the POD sees it (`/repo/.git/worktrees/<id>`, rewritten
 * by the in-pod setup), which means nothing here; the admin dir's own
 * `commondir` is the relative `../..`, so naming it is enough to reach the
 * shared repo. `core.fsmonitor` is pinned off because the repo's config is
 * the agent's to write, and a configured fsmonitor is a command git runs.
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
  // fsmonitor is refused by simple-git's unsafe-argument guard whatever the
  // value; pinning it OFF is the safe direction, so the guard is lifted.
  const git = simpleGit({ baseDir: worktreePath, unsafe: { allowUnsafeFsMonitor: true } })
  const base = [
    '-c', 'core.fsmonitor=false',
    `--git-dir=${path.join(repoPath, '.git', 'worktrees', worktreeId)}`,
    `--work-tree=${worktreePath}`,
  ]
  const run = async (args: string[]): Promise<string[]> =>
    (await git.raw([...base, ...args])).split('\0').filter((p) => p !== '')
  const [listed, deleted, ignored, untrackedDirs, status] = await Promise.all([
    run(['ls-files', '-z', '--cached', '--others', '--exclude-standard']),
    run(['ls-files', '-z', '--deleted']),
    run(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']),
    run(['ls-files', '-z', '--others', '--exclude-standard', '--directory']),
    run([
      '-c', 'core.checkStat=minimal', '-c', 'core.trustctime=false', '--no-optional-locks',
      'status', '--porcelain=v1', '-z', '--untracked-files=all',
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
