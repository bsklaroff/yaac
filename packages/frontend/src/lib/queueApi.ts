import { api } from './api'
import type { AgentMode, AgentTool, PermissionMode, QueuedWorktreeEntry } from '@yaac/shared/types'

/**
 * Queued worktrees (docs/queued-worktrees.md): create requests saved to run
 * when their parent — a worktree, or another queued entry — stops. None of
 * these are optimistic: entries ride the snapshot, so the server's push is
 * what re-renders the sidebar.
 */

/** Every setting a queued entry stores — all concrete, so what the sidebar
 *  shows is what will launch. */
export interface QueuedSettings {
  prompt: string
  tool: AgentTool
  model: string
  mode: AgentMode
  permissionMode: PermissionMode
  branch: string
}

/** Queue a worktree to start when `parent` (a worktree or entry id) stops.
 *  `draftId` names the draft it was made from, deleted once it is queued. */
export async function queueWorktree(
  project: string,
  parent: string,
  settings: QueuedSettings,
  draftId?: string,
): Promise<QueuedWorktreeEntry> {
  return await api.worktree.queue.create.$post({
    json: { project, parent, ...settings, ...(draftId !== undefined ? { draftId } : {}) },
  })
}

/** Replace an entry's settings, and its parent when `parent` is given. */
export async function updateQueuedWorktree(
  id: string,
  patch: Partial<QueuedSettings> & { parent?: string },
): Promise<QueuedWorktreeEntry> {
  return await api.worktree.queue.update.$post({ json: { id, ...patch } })
}

/** Delete an entry; its own queued children move up to its parent. */
export async function discardQueuedWorktree(id: string): Promise<void> {
  await api.worktree.queue.discard.$post({ json: { id } })
}

/** Start an entry now, whatever its parent is doing. */
export async function runQueuedWorktree(id: string): Promise<{ worktreeId: string }> {
  return await api.worktree.queue.run.$post({ json: { id } })
}
