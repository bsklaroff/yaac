import { api } from './api'
import type { WorktreeChanges, WorktreeGitStatus } from '@yaac/shared/types'

/** The single layout target a worktree's changes/review pane uses. */
export const CHANGES_TARGET = 'changes'

/** Whether a layout target is the changes pane (vs a terminal/preview). */
export function isChangesTarget(target: string): boolean {
  return target === CHANGES_TARGET
}

/** The worktree's review diff — everything changed in the worktree since it
 *  forked from the base branch. `base`, when given, overrides the branch the
 *  diff is taken against (fork point vs `origin/<base>`); omitting it keeps the
 *  worktree's own fork-base default. */
export async function getWorktreeChanges(worktreeId: string, base?: string): Promise<WorktreeChanges> {
  return api.worktree[':id'].changes.$get({
    param: { id: worktreeId },
    query: base ? { base } : {},
  })
}

/** How far the worktree's HEAD is ahead of / behind `base` — or, omitted, the
 *  branch it forked from — for the status bar above its panes. */
export async function getWorktreeGitStatus(worktreeId: string, base?: string): Promise<WorktreeGitStatus> {
  return api.worktree[':id']['git-status'].$get({
    param: { id: worktreeId },
    query: base ? { base } : {},
  })
}
