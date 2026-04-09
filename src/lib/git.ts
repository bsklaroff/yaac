import simpleGit from 'simple-git'

export async function cloneRepo(remoteUrl: string, destPath: string): Promise<void> {
  await simpleGit().clone(remoteUrl, destPath)
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

export async function fetchOrigin(repoPath: string): Promise<void> {
  await simpleGit(repoPath).fetch('origin')
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
