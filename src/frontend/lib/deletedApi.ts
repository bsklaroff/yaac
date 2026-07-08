import { api, ApiError } from './apiClient'
import type { DeletedSessionEntry } from '@/shared/types'

/**
 * Deleted sessions for a project — sessions whose containers are gone but
 * whose transcripts remain on disk, so they can be restarted (resumed).
 * Mirrors `yaac session list -d`.
 *
 * An older daemon may not serve this route; a 404 degrades to "none" rather
 * than surfacing an error for a non-essential list (skew resilience).
 */
export async function getDeletedSessions(
  projectSlug: string,
  limit = 25,
): Promise<DeletedSessionEntry[]> {
  const params = new URLSearchParams({ project: projectSlug, limit: String(limit) })
  try {
    return await api.get<DeletedSessionEntry[]>(`/session/list-deleted?${params.toString()}`)
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return []
    throw err
  }
}
