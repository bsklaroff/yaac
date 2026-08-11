import { worktreeRuntime } from '#runtime/driver'
import { cleanupWorktreeDetached } from './cleanup'
import { ServerError } from '@yaac/shared/errors'

export interface StoppedWorktreeInfo {
  worktreeId: string
  jobName: string
  projectSlug: string
}

/**
 * Resolve a worktree by prefix match on id or Job/pod name and schedule a
 * detached cleanup (delete the Job + prune the worktree dirs). The *git
 * worktree* is deliberately kept — that is what makes this a stop rather
 * than a delete, and what a later restart re-attaches to. Throws
 * `NOT_FOUND` if nothing matches, `RUNTIME_UNAVAILABLE` if the cluster
 * can't be reached.
 */
export async function stopWorktree(idOrName: string): Promise<StoppedWorktreeInfo> {
  const target = await worktreeRuntime().findForTeardown(idOrName)
  if (!target) {
    throw new ServerError(
      'NOT_FOUND',
      `No worktree found matching "${idOrName}". Run "yaac worktree list" to see running worktrees.`,
    )
  }

  await cleanupWorktreeDetached({
    jobName: target.unitName,
    projectSlug: target.projectSlug,
    worktreeId: target.workspaceId,
  })
  return {
    jobName: target.unitName,
    worktreeId: target.workspaceId,
    projectSlug: target.projectSlug,
  }
}
