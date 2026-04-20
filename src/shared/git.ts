import simpleGit from 'simple-git'

/**
 * Read the user's global git identity. Returns `null` if either
 * `user.name` or `user.email` is unset, or if `git` itself fails.
 *
 * Lives in shared because both the CLI (which prompts when missing
 * and forwards the resolved pair to the daemon) and the daemon
 * (which falls back to the global config during non-interactive
 * prewarm creation) need it.
 */
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
