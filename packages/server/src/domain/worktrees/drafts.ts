/**
 * Draft worktrees (docs/draft-worktrees.md): what the create dialog held when
 * the user closed it and chose to keep it. Nothing runs from a draft on its
 * own — the dialog reopens on it, and creating or queueing from there
 * discards it.
 */
import {
  deleteDraftWorktree,
  getProjectRow,
  insertDraftWorktree,
  listDraftWorktreeRows,
  updateDraftWorktree,
  type DraftWorktreeRow,
} from '#db'
import { ServerError } from '@yaac/shared/errors'
import { formatUtcTimestamp } from '@yaac/shared/time'
import { normalizeTitle } from '@yaac/shared/titles'
import type { DraftWorktreeEntry, DraftWorktreeSettings } from '@yaac/shared/types'

/** Save a new draft, or replace draft `id`'s settings. A blank title is
 *  none, leaving the draft to be auto-titled. */
export async function saveDraftWorktree(
  projectSlug: string,
  { title, ...rest }: DraftWorktreeSettings,
  id?: string,
): Promise<DraftWorktreeEntry> {
  if (!await getProjectRow(projectSlug)) throw new ServerError('NOT_FOUND', `project ${projectSlug} not found`)
  const named = normalizeTitle(title ?? '')
  const settings = { ...rest, ...(named !== '' ? { title: named } : {}) }
  const row = id === undefined
    ? await insertDraftWorktree(projectSlug, settings)
    : await updateDraftWorktree(projectSlug, id, settings)
  if (!row) throw new ServerError('NOT_FOUND', `project ${projectSlug} has no draft worktree ${id}`)
  return toEntry(row)
}

export async function discardDraftWorktree(id: string): Promise<void> {
  if (!await deleteDraftWorktree(id)) throw new ServerError('NOT_FOUND', `draft worktree ${id} not found`)
}

/** The title generated for draft `id` while it still describes `prompt` —
 *  what a worktree or entry created from the draft carries rather than being
 *  titled again. */
export async function draftGeneratedTitle(
  projectSlug: string,
  id: string | undefined,
  prompt: string | undefined,
): Promise<string | undefined> {
  if (id === undefined || prompt === undefined) return undefined
  const draft = (await listDraftWorktreeRows()).find((d) => d.id === id && d.projectSlug === projectSlug)
  return draft?.prompt === prompt ? draft.generatedTitle : undefined
}

/** The snapshot feed: every project's drafts, oldest first. */
export async function listDraftWorktrees(): Promise<DraftWorktreeEntry[]> {
  return (await listDraftWorktreeRows()).map(toEntry)
}

function toEntry({ createdAt, updatedAt, ...rest }: DraftWorktreeRow): DraftWorktreeEntry {
  return {
    ...rest,
    createdAt: formatUtcTimestamp(createdAt.getTime()),
    updatedAt: formatUtcTimestamp(updatedAt.getTime()),
  }
}
