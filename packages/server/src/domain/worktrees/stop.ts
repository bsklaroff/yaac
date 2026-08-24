import { worktreeDriver } from '#drivers/driver'
import { cleanupWorktreeDetached } from './cleanup'
import { harvestToolCredentials } from '#domain/auth'
import { serverLog } from '#log'
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
  const target = await worktreeDriver().findForTeardown(idOrName)
  if (!target) {
    throw new ServerError(
      'NOT_FOUND',
      `No worktree found matching "${idOrName}". Run "yaac worktree list" to see running worktrees.`,
    )
  }

  // Last chance to notice a token this worktree's agent refreshed. Under an
  // unmediated runtime that refresh landed in the project's tool home and
  // nowhere else, and stopping removes the thing whose liveness was holding
  // the host's own refresh back — so adopt it now rather than leaving the
  // host store stale until the next sweep. Best-effort: a stop must not fail
  // because a credential could not be read.
  await harvestToolCredentials({ slug: target.projectSlug })
    .catch((err: unknown) => serverLog(`[server] credential harvest on stop failed: ${String(err)}`))

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
