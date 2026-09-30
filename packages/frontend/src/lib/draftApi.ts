import { api } from './api'
import type { DraftWorkspaceEntry, DraftWorkspaceSettings } from '@yaac/shared/types'

/**
 * Draft workspaces (docs/draft-workspaces.md): create-dialog contents kept for
 * later. Not optimistic — drafts ride the snapshot, so the server's push is
 * what re-renders the sidebar.
 */

/** Save a new draft, or replace draft `id`'s fields. */
export async function saveDraftWorkspace(
  project: string,
  settings: DraftWorkspaceSettings,
  id?: string,
): Promise<DraftWorkspaceEntry> {
  return await api.workspace.draft.save.$post({ json: { project, ...settings, ...(id !== undefined ? { id } : {}) } })
}

export async function discardDraftWorkspace(id: string): Promise<void> {
  await api.workspace.draft.discard.$post({ json: { id } })
}
