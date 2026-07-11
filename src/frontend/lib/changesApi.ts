import { api } from './apiClient'
import type { SessionChanges } from '@/shared/types'

/** The session's review diff — everything changed in the worktree since it
 *  forked from the base branch. */
export async function getSessionChanges(sessionId: string): Promise<SessionChanges> {
  return api.get<SessionChanges>(`/session/${encodeURIComponent(sessionId)}/changes`)
}
