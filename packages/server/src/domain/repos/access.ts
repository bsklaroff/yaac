import { getRepo, listRepoShares, type RepoRow } from '#db'
import type { Actor } from '#domain/access'
import { ServerError } from '@yaac/shared/errors'
import { isUuid } from '#lib/uuid'

/**
 * Who may act on a repo (docs/project-repos.md): its owner changes it, and
 * its owner or a user it is shared with links it into their projects and
 * starts workspaces with it.
 */

/** The repo, once `principal` is known to own it: NOT_FOUND when there is
 *  none, FORBIDDEN for anyone else but the server itself. */
export async function ownRepo(principal: Actor, repoId: string): Promise<RepoRow> {
  const repo = isUuid(repoId) ? await getRepo(repoId) : undefined
  if (!repo) throw new ServerError('NOT_FOUND', `repo ${repoId} not found`)
  if (principal.kind !== 'system' && principal.userId !== repo.owner) {
    throw new ServerError('FORBIDDEN', 'only the owner of this repo may do that')
  }
  return repo
}

/** Whether a user may link a repo and start workspaces with it: its owner,
 *  or someone it is shared with. Nobody may use a deleted repo. */
export async function canUseRepo(userId: string, repo: RepoRow): Promise<boolean> {
  if (repo.deletedAt !== undefined) return false
  if (repo.owner === userId) return true
  return (await listRepoShares()).some((s) => s.repoId === repo.id && s.userId === userId)
}

/** Refuse with FORBIDDEN unless `userId` may use the repo (`canUseRepo`). */
export async function assertCanUseRepo(userId: string, repo: RepoRow): Promise<void> {
  if (await canUseRepo(userId, repo)) return
  throw new ServerError('FORBIDDEN', repo.deletedAt !== undefined
    ? `${repo.remoteUrl} was deleted by its owner`
    : `${repo.remoteUrl} is not shared with this project's owner`)
}
