import { api } from './api'
import type { WorkspaceChanges, WorkspaceGitStatus } from '@yaac/shared/types'

/** The single layout target a workspace's changes/review pane uses. */
export const CHANGES_TARGET = 'changes'

/** Whether a layout target is the changes pane (vs a terminal/preview). */
export function isChangesTarget(target: string): boolean {
  return target === CHANGES_TARGET
}

/** Everything changed in the workspace since it forked from its base branch.
 *  `base` overrides which branch the diff is taken against. */
export async function getWorkspaceChanges(workspaceId: string, base?: string): Promise<WorkspaceChanges> {
  return api.workspace[':id'].changes.$get({
    param: { id: workspaceId },
    query: base ? { base } : {},
  })
}

/** How far the workspace's HEAD is ahead of / behind `base` (default: the
 *  branch it forked from), for the status bar above its panes. */
export async function getWorkspaceGitStatus(workspaceId: string, base?: string): Promise<WorkspaceGitStatus> {
  return api.workspace[':id']['git-status'].$get({
    param: { id: workspaceId },
    query: base ? { base } : {},
  })
}
