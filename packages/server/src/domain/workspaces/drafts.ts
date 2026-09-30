/**
 * Draft workspaces (docs/draft-workspaces.md): what the create dialog held when
 * the user closed it and chose to keep it. Nothing runs from a draft on its
 * own — the dialog reopens on it, and creating or queueing from there
 * discards it.
 */
import {
  deleteDraftWorkspace,
  getProjectRow,
  insertDraftWorkspace,
  listDraftWorkspaceRows,
  updateDraftWorkspace,
  type DraftWorkspaceRow,
} from '#db'
import { ServerError } from '@yaac/shared/errors'
import { formatUtcTimestamp } from '@yaac/shared/time'
import { normalizeTitle } from '@yaac/shared/titles'
import type { DraftWorkspaceEntry, DraftWorkspaceSettings } from '@yaac/shared/types'

/** Save a new draft, or replace draft `id`'s settings. A blank title is
 *  none, leaving the draft to be auto-titled. */
export async function saveDraftWorkspace(
  projectSlug: string,
  { title, ...rest }: DraftWorkspaceSettings,
  id?: string,
): Promise<DraftWorkspaceEntry> {
  if (!await getProjectRow(projectSlug)) throw new ServerError('NOT_FOUND', `project ${projectSlug} not found`)
  const named = normalizeTitle(title ?? '')
  const settings = { ...rest, ...(named !== '' ? { title: named } : {}) }
  const row = id === undefined
    ? await insertDraftWorkspace(projectSlug, settings)
    : await updateDraftWorkspace(projectSlug, id, settings)
  if (!row) throw new ServerError('NOT_FOUND', `project ${projectSlug} has no draft workspace ${id}`)
  return toEntry(row)
}

export async function discardDraftWorkspace(id: string): Promise<void> {
  if (!await deleteDraftWorkspace(id)) throw new ServerError('NOT_FOUND', `draft workspace ${id} not found`)
}

/** The title generated for draft `id` while it still describes `prompt` —
 *  what a workspace or entry created from the draft carries rather than being
 *  titled again. */
export async function draftGeneratedTitle(
  projectSlug: string,
  id: string | undefined,
  prompt: string | undefined,
): Promise<string | undefined> {
  if (id === undefined || prompt === undefined) return undefined
  const draft = (await listDraftWorkspaceRows()).find((d) => d.id === id && d.projectSlug === projectSlug)
  return draft?.prompt === prompt ? draft.generatedTitle : undefined
}

/** The snapshot feed: every project's drafts, oldest first. */
export async function listDraftWorkspaces(): Promise<DraftWorkspaceEntry[]> {
  return (await listDraftWorkspaceRows()).map(toEntry)
}

function toEntry({ createdAt, updatedAt, ...rest }: DraftWorkspaceRow): DraftWorkspaceEntry {
  return {
    ...rest,
    createdAt: formatUtcTimestamp(createdAt.getTime()),
    updatedAt: formatUtcTimestamp(updatedAt.getTime()),
  }
}
