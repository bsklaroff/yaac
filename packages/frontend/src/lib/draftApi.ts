import { api } from './api'
import type { DraftWorktreeEntry, DraftWorktreeSettings } from '@yaac/shared/types'

/**
 * Draft worktrees (docs/draft-worktrees.md): create-dialog contents kept for
 * later. Not optimistic — drafts ride the snapshot, so the server's push is
 * what re-renders the sidebar.
 */

/** Save a new draft, or replace draft `id`'s fields. */
export async function saveDraftWorktree(
  project: string,
  settings: DraftWorktreeSettings,
  id?: string,
): Promise<DraftWorktreeEntry> {
  return await api.worktree.draft.save.$post({ json: { project, ...settings, ...(id !== undefined ? { id } : {}) } })
}

export async function discardDraftWorktree(id: string): Promise<void> {
  await api.worktree.draft.discard.$post({ json: { id } })
}
