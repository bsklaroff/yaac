import { getDefaultBranch, isGitAuthError, listRemoteBranches } from '#domain/git'
import { fetchRepoOrigin } from './origin'
import { repoDir } from '@yaac/shared/project-paths'
import { ServerError } from '@yaac/shared/errors'

export interface RepoBranches {
  /** Remote-tracking branch names (no `origin/` prefix), newest-committed
   *  first — the order the picker shows. */
  branches: string[]
  /** The remote's default branch (origin/HEAD). */
  defaultBranch: string
}

/**
 * Branch data for the new-workspace picker, from local remote-tracking refs.
 * `refresh` fetches first so a just-pushed branch appears; the frontend shows
 * the fast list, then refreshes in the background. A branch passed via the
 * CLI or `yaac-mama --branch` need not be listed, since create fetches and
 * validates it.
 */
export async function getRepoBranches(repoId: string, opts: { refresh?: boolean } = {}): Promise<RepoBranches> {
  const repo = repoDir(repoId)

  if (opts.refresh) {
    // With no credential (or a local-path remote in tests) the fetch is
    // unauthenticated.
    try {
      await fetchRepoOrigin(repoId)
    } catch (err) {
      // A refusal keeps its own code.
      if (err instanceof ServerError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      if (isGitAuthError(msg)) {
        throw new ServerError(
          'VALIDATION',
          'git authentication failed — the repo\'s credential was rejected. '
          + 'Assign it a new one in Settings → Repos, then retry.',
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
