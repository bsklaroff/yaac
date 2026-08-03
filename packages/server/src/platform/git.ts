import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import simpleGit from 'simple-git'
import { createKeyedMutex } from '#platform/keyed-mutex'
import type { ResolvedGitCredential } from '#features/projects'
import { env } from '@yaac/shared/env'
import { formatSshCommand, torSshOpts } from '@yaac/shared/git'

export function injectTokenIntoUrl(url: string, token: string): string {
  const parsed = new URL(url)
  parsed.username = 'x-access-token'
  parsed.password = token
  return parsed.toString()
}

/**
 * Heuristic for git transport errors caused by rejected credentials
 * (expired/revoked token, insufficient scopes, rejected SSH key), as
 * opposed to network failures or missing refs. Matches the messages git
 * emits for HTTP 401/403 and SSH auth rejection, so callers can replace
 * the raw stderr with an actionable "fix your credential" message.
 */
export function isGitAuthError(message: string): boolean {
  return [
    /authentication failed/i,
    /invalid username or password/i,
    /could not read (Username|Password)/i,
    /returned error: 40[13]/, // curl: "The requested URL returned error: 401"
    /permission denied \(publickey/i, // SSH key rejected
    /permission to .+ denied/i, // GitHub's 403 remote message on push
  ].some((re) => re.test(message))
}

// When Tor is enabled on the server process, route the git subprocess
// through the user's host-machine Tor (assumed already running at
// YAAC_HOST_TOR_SOCKS_URL, default socks5h://127.0.0.1:9050). Returns
// undefined when the toggle is off so simple-git uses its default env.
//
// simple-git's `.env(obj)` replaces the child's env wholesale, so we must
// spread process.env to preserve PATH, HOME, etc.
export function torEnv(): NodeJS.ProcessEnv | undefined {
  if (!env.useTor) return undefined
  const url = env.torSocksUrl
  // eslint-disable-next-line no-process-env -- forward the full host env to the git subprocess (PATH/HOME/…), adding the Tor proxy vars
  return { ...process.env, ALL_PROXY: url, NO_PROXY: 'localhost,127.0.0.1' }
}

/**
 * Build the host-side GIT_SSH_COMMAND for a registered SSH key. The server
 * has filesystem access to the key, so it uses `-i <keyPath>` directly.
 * The session container never sees this string — its own GIT_SSH_COMMAND is
 * built separately and uses the proxy's ssh-agent instead of `-i`.
 */
export function buildHostSideGitSshCommand(keyPath: string, knownHostsPath: string): string {
  return formatSshCommand([
    'ssh', '-F', '/dev/null',
    '-i', keyPath,
    '-o', `UserKnownHostsFile=${knownHostsPath}`,
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'IdentitiesOnly=yes',
    ...torSshOpts(),
  ])
}

/**
 * Write a known_hosts file atomically with mode 0600. Idempotent.
 */
export async function writeKnownHostsFile(entries: string[], destPath: string): Promise<void> {
  const content = entries.join('\n') + (entries.length ? '\n' : '')
  await fs.mkdir(path.dirname(destPath), { recursive: true })
  const tmp = `${destPath}.tmp-${crypto.randomBytes(6).toString('hex')}`
  await fs.writeFile(tmp, content, { mode: 0o600 })
  await fs.rename(tmp, destPath)
}

/**
 * Build the env object to pass to `simpleGit.env(...)` for a given
 * credential. For SSH, we also need a known_hosts path on disk so the
 * GIT_SSH_COMMAND can point at it. Caller is responsible for writing
 * the file first.
 */
export function gitEnvForCredential(
  credential: ResolvedGitCredential | null,
  knownHostsPath?: string,
): NodeJS.ProcessEnv | undefined {
  // eslint-disable-next-line no-process-env -- forward the full host env to the git subprocess when Tor is off (torEnv spreads it when on)
  const base = torEnv() ?? { ...process.env }
  if (credential?.kind === 'ssh') {
    if (!knownHostsPath) throw new Error('SSH credentials require a knownHostsPath')
    base.GIT_SSH_COMMAND = buildHostSideGitSshCommand(credential.privateKeyPath, knownHostsPath)
    return base
  }
  // HTTPS or no credential: Tor env (if any) is enough; otherwise simple-git
  // can use process.env directly.
  return torEnv()
}

async function ensureKnownHostsFileForCredential(
  credential: ResolvedGitCredential | null,
): Promise<string | undefined> {
  if (credential?.kind !== 'ssh') return undefined
  // Per-credential known_hosts under the OS tmp dir, keyed by content hash.
  // Stable so concurrent clones reuse the same file.
  const hash = crypto.createHash('sha256').update(credential.knownHostsEntry).digest('hex').slice(0, 12)
  const dest = path.join(os.tmpdir(), `yaac-known_hosts-${hash}`)
  await writeKnownHostsFile([credential.knownHostsEntry], dest)
  return dest
}

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
  if (credential?.kind === 'ssh') {
    const knownHostsPath = await ensureKnownHostsFileForCredential(credential)
    const env = gitEnvForCredential(credential, knownHostsPath)
    await gitWithCredentialEnv(undefined, env).clone(remoteUrl, destPath)
    return
  }
  // No credential: unauthenticated clone (works for public HTTPS repos).
  await gitWithCredentialEnv(undefined, torEnv()).clone(remoteUrl, destPath)
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
 * upstream is recorded. For session branches (`agent/<sessionId>`) this is
 * the durable record of the reference branch the session was created from:
 * `startJobWithSetup` writes it before the tmux session exists, and the
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
      const remoteUrl = (await git.remote(['get-url', 'origin']))!.trim()
      const authedUrl = injectTokenIntoUrl(remoteUrl, credential.token)
      await git.raw(['fetch', authedUrl, '+refs/heads/*:refs/remotes/origin/*', '--update-head-ok'])
      return
    }
    if (credential?.kind === 'ssh') {
      const knownHostsPath = await ensureKnownHostsFileForCredential(credential)
      const env = gitEnvForCredential(credential, knownHostsPath)
      await gitWithCredentialEnv(repoPath, env).fetch('origin')
      return
    }
    await gitWithCredentialEnv(repoPath, torEnv()).fetch('origin')
  })
}

/**
 * Add a session worktree. `--no-track` is deliberate: setting up branch
 * tracking here would write the shared `.git/config` from the host, and a
 * host-side write replaces the file's inode underneath the VM-kernel
 * virtiofs cache that session pods read `/repo/.git` through — until the
 * stale dentry expires (a few seconds), every git command in a pod dies
 * with "fatal: unknown error occurred while reading the configuration
 * files". The upstream is configured from inside the pod instead (see
 * `startJobWithSetup`), where the write stays cache-coherent for all pods
 * and the host alike. With no config write left here, concurrent adds no
 * longer race git's config.lock and need no serialization.
 */
export async function addWorktree(repoPath: string, worktreePath: string, branchName: string, startPoint?: string): Promise<void> {
  const args = ['worktree', 'add', '--no-track', worktreePath, '-b', branchName]
  if (startPoint) args.push(startPoint)
  await simpleGit(repoPath).raw(args)
}
