import simpleGit from 'simple-git'

export function injectTokenIntoUrl(url: string, token: string): string {
  const parsed = new URL(url)
  parsed.username = 'x-access-token'
  parsed.password = token
  return parsed.toString()
}

export async function cloneRepo(remoteUrl: string, destPath: string, githubToken?: string): Promise<void> {
  if (githubToken) {
    const authedUrl = injectTokenIntoUrl(remoteUrl, githubToken)
    await simpleGit().clone(authedUrl, destPath)
    // Strip credentials from the stored remote URL
    await simpleGit(destPath).remote(['set-url', 'origin', remoteUrl])
  } else {
    await simpleGit().clone(remoteUrl, destPath)
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
    const git = simpleGit(repoPath)
    const remoteUrl = (await git.remote(['get-url', 'origin']))!.trim()
    const authedUrl = injectTokenIntoUrl(remoteUrl, githubToken)
    await git.raw(['fetch', authedUrl, '+refs/heads/*:refs/remotes/origin/*', '--update-head-ok'])
  } else {
    await simpleGit(repoPath).fetch('origin')
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

export async function getGitUserConfig(): Promise<{ name: string; email: string } | null> {
  try {
    const git = simpleGit()
    const name = (await git.getConfig('user.name', 'global')).value
    const email = (await git.getConfig('user.email', 'global')).value
    if (name && email) return { name, email }
    return null
  } catch {
    return null
  }
}
