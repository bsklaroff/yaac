import { api } from './api'
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
    return await api.session['list-deleted'].$get({
      query: { project: projectSlug, limit: String(limit) },
    })
  } catch (err) {
    if (err instanceof ServerError && err.code === 'NOT_FOUND') return []
    throw err
  }
}

/**
 * Mark an abnormal death as seen — the user viewed its detail in the deleted
 * overlay, so the notification dot / row highlight should clear. Persisted on
 * the server (session row) so the acknowledgement is durable and
 * shared across clients. Best-effort: a failed write just re-shows the dot,
 * which the next view clears again, so callers fire-and-forget.
 */
export async function markDeathSeen(projectSlug: string, sessionId: string): Promise<void> {
  try {
    await api.session['mark-death-seen'].$post({ json: { projectSlug, sessionId } })
  } catch {
    // Best-effort: a lost write just re-shows the dot, which the next view
    // clears again. Swallow so fire-and-forget callers need no .catch.
  }
}
