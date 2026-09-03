import { worktreeDriver } from '#drivers/driver'
import { deleteWorktreeState } from './cleanup'
import { applyWorktreeEvent, findWorktreeRow } from '#db'
import { ServerError } from '@yaac/shared/errors'

export interface DeletedWorktreeInfo {
  projectSlug: string
  worktreeId: string
}

/**
 * Discard a stopped worktree for good — its checkout (diff and all), git's
 * admin dir for it, its state and ephemeral-module dirs, its opencode
 * database, and the row and conversation links that named it.
 *
 * The counterpart to `stopWorktree`, which deliberately keeps every one of
 * those so a restart can re-attach. A stop is "not now"; this is the answer
 * to the other question a user has about a worktree they are finished with,
 * and nothing else asks it: a project accumulates one checkout per worktree
 * it has ever run, each with its own installed dependencies, and the only
 * other path that reclaims any of them takes the whole project with it.
 *
 * Refuses a worktree that still has a runtime, and fails CLOSED — the
 * substrate's own word, so an unreachable one propagates
 * (`RUNTIME_UNAVAILABLE`) rather than reading as "nothing is running". The
 * bytes being removed are the directory a live workspace's agents are
 * working in. Stopping it first is the caller's to do, deliberately: a
 * delete that stopped things on the way would put two questions behind one
 * confirmation.
 *
 * Bytes first, row last, and the row SURVIVES a failed rm: the row is the
 * last name anything has for the checkout, so erasing it over leftovers is
 * what turns a retryable failure into bytes nothing can ever reach again
 * (docs/worktree-storage.md). The worktree keeps its place in the stopped
 * listing, and a second delete retries.
 *
 * The BRANCH is deliberately left. Its commits are the work, they are in the
 * project's one clone rather than in the checkout, and deleting refs is not
 * what someone reclaiming a directory asked for.
 */
export async function deleteWorktree(idOrName: string): Promise<DeletedWorktreeInfo> {
  const live = await worktreeDriver().find(idOrName)
  if (live) {
    throw new ServerError(
      'CONFLICT',
      `Worktree ${live.workspaceId} is still running — stop it first `
      + `("yaac worktree stop ${live.workspaceId}").`,
    )
  }

  const row = await findWorktreeRow(idOrName)
  if (!row) {
    throw new ServerError(
      'NOT_FOUND',
      `No stopped worktree found matching "${idOrName}". `
      + 'Run "yaac worktree list -s" to see stopped worktrees.',
    )
  }
  const { projectSlug, worktreeId } = row

  if (!await deleteWorktreeState(projectSlug, worktreeId)) {
    throw new ServerError(
      'INTERNAL',
      `Could not remove everything worktree ${worktreeId} has on disk; `
      + 'it is kept in the stopped list so the delete can be retried.',
    )
  }

  await applyWorktreeEvent({ type: 'worktree-forgotten', projectSlug, worktreeId })
  return { projectSlug, worktreeId }
}
