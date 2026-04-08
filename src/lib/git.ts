import simpleGit from 'simple-git'

export async function cloneRepo(remoteUrl: string, destPath: string): Promise<void> {
  await simpleGit().clone(remoteUrl, destPath)
}

export async function getDefaultBranch(repoPath: string): Promise<string> {
  const branch = await simpleGit(repoPath).revparse(['--abbrev-ref', 'HEAD'])
  return branch.trim()
}

export async function fetchAndPullDefault(repoPath: string): Promise<void> {
  const git = simpleGit(repoPath)
  const branch = await getDefaultBranch(repoPath)
  await git.fetch('origin')
  await git.raw(['merge', '--ff-only', `origin/${branch}`])
}

export async function addWorktree(repoPath: string, worktreePath: string, branchName: string, upstream?: string): Promise<void> {
  await simpleGit(repoPath).raw(['worktree', 'add', worktreePath, '-b', branchName])
  if (upstream) {
    await simpleGit(repoPath).raw(['branch', '--set-upstream-to', upstream, branchName])
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
