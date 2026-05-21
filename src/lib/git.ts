import simpleGit from 'simple-git'

export function injectTokenIntoUrl(url: string, token: string): string {
  const parsed = new URL(url)
  parsed.username = 'x-access-token'
  parsed.password = token
  return parsed.toString()
}

// Parses YAAC_USE_TOR with permissive truthy semantics: unset, empty,
// "0", and "false" (case-insensitive) are off; everything else is on.
export function isTorEnabled(): boolean {
  const raw = process.env.YAAC_USE_TOR
  if (raw === undefined) return false
  const v = raw.trim().toLowerCase()
  if (v === '' || v === '0' || v === 'false') return false
  return true
}

// When Tor is enabled on the daemon process, route the git subprocess
// through the user's host-machine Tor (assumed already running at
// YAAC_HOST_TOR_SOCKS_URL, default socks5h://127.0.0.1:9050). Returns
// undefined when the toggle is off so simple-git uses its default env.
//
// simple-git's `.env(obj)` replaces the child's env wholesale, so we must
// spread process.env to preserve PATH, HOME, etc.
export function torEnv(): NodeJS.ProcessEnv | undefined {
  if (!isTorEnabled()) return undefined
  const url = process.env.YAAC_HOST_TOR_SOCKS_URL ?? 'socks5h://127.0.0.1:9050'
  return { ...process.env, ALL_PROXY: url, NO_PROXY: 'localhost,127.0.0.1' }
}

function gitWithTorEnv(baseDir?: string): ReturnType<typeof simpleGit> {
  const git = baseDir ? simpleGit(baseDir) : simpleGit()
  const env = torEnv()
  return env ? git.env(env) : git
}

export async function cloneRepo(remoteUrl: string, destPath: string, githubToken?: string): Promise<void> {
  if (githubToken) {
    const authedUrl = injectTokenIntoUrl(remoteUrl, githubToken)
    await gitWithTorEnv().clone(authedUrl, destPath)
    // Strip credentials from the stored remote URL
    await simpleGit(destPath).remote(['set-url', 'origin', remoteUrl])
  } else {
    await gitWithTorEnv().clone(remoteUrl, destPath)
  }
}

export async function getDefaultBranch(repoPath: string): Promise<string> {
  const git = simpleGit(repoPath)
  try {
    // Prefer the remote HEAD symref (e.g. "refs/remotes/origin/main")
    const ref = await git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD'])
    // Returns something like "refs/remotes/origin/main"
    const match = ref.trim().match(/^refs\/remotes\/origin\/(.+)$/)
    if (match) return match[1]
  } catch {
    // Fallback: origin/HEAD may not be set (e.g. local-only repos)
  }
  // Fall back to whatever branch is checked out locally
  const branch = await git.revparse(['--abbrev-ref', 'HEAD'])
  return branch.trim()
}

export async function fetchOrigin(repoPath: string, githubToken?: string): Promise<void> {
  if (githubToken) {
    const git = gitWithTorEnv(repoPath)
    const remoteUrl = (await git.remote(['get-url', 'origin']))!.trim()
    const authedUrl = injectTokenIntoUrl(remoteUrl, githubToken)
    await git.raw(['fetch', authedUrl, '+refs/heads/*:refs/remotes/origin/*', '--update-head-ok'])
  } else {
    await gitWithTorEnv(repoPath).fetch('origin')
  }
}

export async function addWorktree(repoPath: string, worktreePath: string, branchName: string, startPoint?: string): Promise<void> {
  const args = ['worktree', 'add', worktreePath, '-b', branchName]
  if (startPoint) args.push(startPoint)
  await simpleGit(repoPath).raw(args)
  if (startPoint) {
    await simpleGit(repoPath).raw(['branch', '--set-upstream-to', startPoint, branchName])
  }
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await simpleGit(repoPath).raw(['worktree', 'remove', worktreePath])
}

export async function getRemoteHeadCommit(repoPath: string): Promise<string> {
  const defaultBranch = await getDefaultBranch(repoPath)
  return (await simpleGit(repoPath).revparse([`origin/${defaultBranch}`])).trim()
}

export { getGitUserConfig } from '@/shared/git'
