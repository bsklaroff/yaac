import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import simpleGit from 'simple-git'
import type { ResolvedGitCredential } from '@/lib/project/credentials'
import { env } from '@/shared/env'
import { formatSshCommand, torSshOpts } from '@/shared/git'

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

// When Tor is enabled on the daemon process, route the git subprocess
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
 * Build the host-side GIT_SSH_COMMAND for a registered SSH key. The daemon
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

export async function fetchOrigin(
  repoPath: string,
  credential: ResolvedGitCredential | null,
): Promise<void> {
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
}

/**
 * Per-repo tail of the in-flight `addWorktree` chain. Concurrent adds on
 * one repo race git's `.git/config` lock (`worktree add -b … origin/…`
 * and `branch --set-upstream-to` both write branch config), failing one
 * side with "could not lock config file .git/config: File exists" — seen
 * when a prewarm spare spawn and a user create hit the same project
 * simultaneously. Serializing per repo removes the race; different repos
 * still add in parallel.
 */
const worktreeAddQueues = new Map<string, Promise<void>>()

export async function addWorktree(repoPath: string, worktreePath: string, branchName: string, startPoint?: string): Promise<void> {
  const prev = worktreeAddQueues.get(repoPath) ?? Promise.resolve()
  // A failed predecessor must not poison the queue — each add gets its
  // own verdict.
  const run = prev.catch(() => { /* predecessor's caller saw its error */ }).then(async () => {
    const args = ['worktree', 'add', worktreePath, '-b', branchName]
    if (startPoint) args.push(startPoint)
    await simpleGit(repoPath).raw(args)
    if (startPoint) {
      await simpleGit(repoPath).raw(['branch', '--set-upstream-to', startPoint, branchName])
    }
  })
  worktreeAddQueues.set(repoPath, run)
  try {
    await run
  } finally {
    if (worktreeAddQueues.get(repoPath) === run) worktreeAddQueues.delete(repoPath)
  }
}
