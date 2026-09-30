import { getDefaultBranch, isGitAuthError, listRemoteBranches } from '#domain/git'
import { fetchProjectOrigin } from './origin'
import { repoDir } from '@yaac/shared/project-paths'
import { ServerError } from '@yaac/shared/errors'

export interface ProjectBranches {
  /** Remote-tracking branch names (no `origin/` prefix), newest-committed
   *  first — the order the picker shows. */
  branches: string[]
  /** The remote's default branch (origin/HEAD). */
  defaultBranch: string
}

/**
 * Branch data for the new-worktree picker. Reads local remote-tracking refs
 * (instant); `refresh` runs a credentialed fetch first so a just-pushed
 * branch appears — the frontend shows the instant list and re-fetches with
 * refresh in the background. A branch named by the CLI or `yaac-mama
 * --branch` need not be listed: the create re-fetches and validates it.
 */
export async function getProjectBranches(slug: string, opts: { refresh?: boolean } = {}): Promise<ProjectBranches> {
  const repo = repoDir(slug)

  if (opts.refresh) {
    // No credential (or a local-path remote, in test fixtures) fetches
    // unauthenticated rather than failing the refresh.
    try {
      await fetchProjectOrigin(slug)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (isGitAuthError(msg)) {
        throw new ServerError(
          'VALIDATION',
          'git authentication failed — the project\'s credential was rejected. '
          + 'Assign it a new one in Settings → Git credentials, then retry.',
        )
      }
      throw new ServerError('INTERNAL', `could not fetch from remote: ${msg}`)
    }
  }

  const [branches, defaultBranch] = await Promise.all([
    listRemoteBranches(repo),
    getDefaultBranch(repo),
  ])
  return { branches, defaultBranch }
}
