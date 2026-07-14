import { api } from './api'
import type { SessionChanges } from '@yaac/shared/types'

/** The single layout target a session's changes/review pane uses. */
export const CHANGES_TARGET = 'changes'

/** Whether a layout target is the changes pane (vs a terminal/preview). */
export function isChangesTarget(target: string): boolean {
  return target === CHANGES_TARGET
}

/** The session's review diff — everything changed in the worktree since it
 *  forked from the base branch. `base`, when given, overrides the branch the
 *  diff is taken against (fork point vs `origin/<base>`); omitting it keeps the
 *  session's own fork-base default. */
export async function getSessionChanges(sessionId: string, base?: string): Promise<SessionChanges> {
  return api.session[':id'].changes.$get({
    param: { id: sessionId },
    query: base ? { base } : {},
  })
}
