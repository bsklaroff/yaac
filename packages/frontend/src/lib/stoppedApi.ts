import { api } from './api'
import { ServerError } from '@yaac/shared/errors'
import type { StoppedWorkspaceEntry } from '@yaac/shared/types'

/**
 * A project's stopped workspaces: those no longer running whose transcripts
 * remain, so they can be resumed. Mirrors `yaac workspace list -s`.
 *
 * An older server may lack this route, so a 404 returns an empty list.
 */
export async function getStoppedWorkspaces(
  projectSlug: string,
  limit = 100,
): Promise<StoppedWorkspaceEntry[]> {
  try {
    return await api.workspace['list-stopped'].$get({
      query: { project: projectSlug, limit: String(limit) },
    })
  } catch (err) {
    if (err instanceof ServerError && err.code === 'NOT_FOUND') return []
    throw err
  }
}

/**
 * Mark an abnormal death as seen, after the user viewed it in the stopped
 * overlay, to clear its notification dot. Stored on the server so every
 * client sees it. Best-effort: a failed write only re-shows the dot, so
 * errors are swallowed and callers need not await.
 */
export async function markDeathSeen(projectSlug: string, workspaceId: string): Promise<void> {
  try {
    await api.workspace['mark-death-seen'].$post({ json: { projectSlug, workspaceId } })
  } catch {
    // Best-effort; see above.
  }
}

/**
 * Mark every abnormal death in the project as seen (the overlay's "Mark all
 * as read"). Best-effort, like `markDeathSeen`.
 */
export async function markAllDeathsSeen(projectSlug: string): Promise<void> {
  try {
    await api.workspace['mark-all-deaths-seen'].$post({ json: { projectSlug } })
  } catch {
    // Best-effort — see markDeathSeen.
  }
}
