import {
  fetchOrigin,
  getDefaultBranch,
  isGitAuthError,
  listRemoteBranches,
  originRemoteUrl,
} from '#domain/git'
import { resolveProjectConfig } from './config'
import { resolveCredentialForUrl } from './credentials'
import { repoDir } from '@yaac/shared/project-paths'
import { ServerError } from '@yaac/shared/errors'

export interface ProjectBranches {
  /** Remote-tracking branch names (no `origin/` prefix), newest-committed
   *  first — the order the picker shows. */
  branches: string[]
  /** The remote's default branch (origin/HEAD). */
  defaultBranch: string
  /** The project's configured default reference branch, if set. */
  referenceBranch: string | null
}

/**
 * Branch data for the new-worktree picker. Reads local remote-tracking refs
 * (instant); `refresh` runs a credentialed fetch first so a just-pushed
 * branch appears — the frontend shows the instant list and re-fetches with
 * refresh in the background. Free-typed branches that aren't listed still
 * work at create time, which re-fetches and validates itself.
 */
export async function getProjectBranches(slug: string, opts: { refresh?: boolean } = {}): Promise<ProjectBranches> {
  const repo = repoDir(slug)

  if (opts.refresh) {
    const remoteUrl = await originRemoteUrl(repo)
    // A local-path remote (test fixtures) isn't parseable as https/scp —
    // fetch it unauthenticated instead of failing the refresh.
    const credential = await resolveCredentialForUrl(remoteUrl).catch(() => null)
    try {
      await fetchOrigin(repo, credential)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (isGitAuthError(msg)) {
        throw new ServerError(
          'AUTH_REQUIRED',
          'git authentication failed — the stored credential was rejected. '
          + 'Run "yaac auth update" to replace it, then retry.',
        )
      }
      throw new ServerError('INTERNAL', `could not fetch from remote: ${msg}`)
    }
  }

  const [branches, defaultBranch, config] = await Promise.all([
    listRemoteBranches(repo),
    getDefaultBranch(repo),
    resolveProjectConfig(slug),
  ])
  return { branches, defaultBranch, referenceBranch: config?.referenceBranch ?? null }
}
