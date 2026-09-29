import { purgeProjectBytes } from './project-purge'
import {
  deleteProjectAgentSessions,
  deleteProjectDraftWorktrees,
  deleteProjectEnvVars,
  deleteProjectQueuedWorktrees,
  deleteProjectRow,
  deleteProjectWorktreeGroups,
  deleteProjectWorktrees,
  getProjectRow,
} from '#db'
import { ServerError } from '@yaac/shared/errors'
import { dropProjectClaudeKeychainItem } from '@yaac/shared/tool-auth'

/**
 * Remove a project: its live worktrees and every byte it owns, then the rows
 * that said it existed. Throws `NOT_FOUND` if the project does not exist.
 *
 * Which projects exist is the server's own record, so the existence check
 * and the row deletes are here, and the bytes are one call
 * (`purgeProjectBytes`). Ordering across the two matters: the bytes go
 * first, because while the project's record exists the project exists, so a
 * purge that then failed would leave a clone nothing can list, remove, or
 * re-add.
 *
 * Lives here rather than in #domain/projects because it is orchestration,
 * not storage: keeping it there made the project store import the features
 * that depend on it.
 */
export async function removeProject(slug: string): Promise<void> {
  const row = await getProjectRow(slug)
  if (!row) throw new ServerError('NOT_FOUND', `project ${slug} not found`)

  await purgeProjectBytes({ slug, id: row.id })
  // The macOS Keychain item a containerless claude keeps for the project's
  // tool home, which is named by the home's path and so would otherwise be
  // found again by the next project of this slug. A no-op anywhere else.
  dropProjectClaudeKeychainItem(slug)

  // Forget the project's worktrees: the deleted listing is driven by rows
  // now, and the worktrees and transcripts they point at went with the dirs
  // above — leaving them would list worktrees whose restart resolves into a
  // project that no longer exists.
  await deleteProjectWorktrees(slug)
  await deleteProjectAgentSessions(slug)
  // The sidebar groups those worktrees were filed under have nothing left to
  // file.
  await deleteProjectWorktreeGroups(slug)
  // And the requests queued to run after them, and the drafts, which have
  // no project to launch into.
  await deleteProjectQueuedWorktrees(slug)
  await deleteProjectDraftWorktrees(slug)
  // The project's environment, secrets included. The copy of those secrets
  // the egress path was holding went with the substrate, above.
  await deleteProjectEnvVars(slug)
  // The project's own record goes last: while it exists the project exists,
  // so dropping it first would make a teardown that then failed leave a
  // clone nothing can list, remove, or re-add.
  await deleteProjectRow(slug)
}
