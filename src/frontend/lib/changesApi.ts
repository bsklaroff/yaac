import { api } from './apiClient'
import type { SessionChanges } from '@/shared/types'

/** The single layout target a session's changes/review pane uses. */
export const CHANGES_TARGET = 'changes'

/** Whether a layout target is the changes pane (vs a terminal/preview). */
export function isChangesTarget(target: string): boolean {
  return target === CHANGES_TARGET
}

/** The session's review diff — everything changed in the worktree since it
 *  forked from the base branch. */
export async function getSessionChanges(sessionId: string): Promise<SessionChanges> {
  return api.get<SessionChanges>(`/session/${encodeURIComponent(sessionId)}/changes`)
}
