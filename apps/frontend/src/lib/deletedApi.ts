import { api } from './apiClient'
import type { DeletedSessionEntry } from '@yaac/shared/types'

/**
 * Deleted sessions for a project — sessions whose containers are gone but
 * whose transcripts remain on disk, so they can be restarted (resumed).
 * Mirrors `yaac session list -d`.
 */
export async function getDeletedSessions(
  projectSlug: string,
  limit = 25,
): Promise<DeletedSessionEntry[]> {
  const params = new URLSearchParams({ project: projectSlug, limit: String(limit) })
  return api.get<DeletedSessionEntry[]>(`/session/list-deleted?${params.toString()}`)
}
