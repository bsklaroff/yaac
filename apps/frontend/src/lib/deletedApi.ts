import { rpc } from './rpc'
import { ServerError } from '@yaac/shared/errors'
import type { DeletedSessionEntry } from '@yaac/shared/types'

/**
 * Deleted sessions for a project — sessions whose containers are gone but
 * whose transcripts remain on disk, so they can be restarted (resumed).
 * Mirrors `yaac session list -d`.
 *
 * An older server may not serve this route; a 404 degrades to "none" rather
 * than surfacing an error for a non-essential list (skew resilience).
 */
export async function getDeletedSessions(
  projectSlug: string,
  limit = 100,
): Promise<DeletedSessionEntry[]> {
  try {
    return await rpc.session['list-deleted'].$get({
      query: { project: projectSlug, limit: String(limit) },
    }).then((r) => r.json())
  } catch (err) {
    if (err instanceof ServerError && err.code === 'NOT_FOUND') return []
    throw err
  }
}
