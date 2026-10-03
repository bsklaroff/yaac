/**
 * Draft workspaces (docs/draft-workspaces.md): create-dialog contents the
 * user chose to keep. Nothing runs from a draft; creating or queueing from
 * it discards it.
 */
import { notifyWorkspaceListChanged } from '#notify'
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

/** Save a new draft, or replace draft `id`'s settings. A blank title leaves
 *  the draft to be auto-titled. */
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

/** Drafts a create or queue is being made from, left out of the snapshot
 *  until it succeeds (deleting the draft) or fails (showing it again). */
const launching = new Set<string>()

/** Run a create or queue made from draft `id`, if any, then delete the
 *  draft. A failure keeps the draft. */
export async function runFromDraft<T>(id: string | undefined, run: () => Promise<T>): Promise<T> {
  if (id === undefined) return await run()
  launching.add(id)
  notifyWorkspaceListChanged()
  try {
    const result = await run()
    await deleteDraftWorkspace(id)
    return result
  } finally {
    launching.delete(id)
    notifyWorkspaceListChanged()
  }
}

export async function discardDraftWorkspace(id: string): Promise<void> {
  if (!await deleteDraftWorkspace(id)) throw new ServerError('NOT_FOUND', `draft workspace ${id} not found`)
}

/** Draft `id`'s generated title, if the draft's prompt is still `prompt`.
 *  Reused by a workspace created from the draft instead of titling again. */
export async function draftGeneratedTitle(
  projectSlug: string,
  id: string | undefined,
  prompt: string | undefined,
): Promise<string | undefined> {
  if (id === undefined || prompt === undefined) return undefined
  const draft = (await listDraftWorkspaceRows()).find((d) => d.id === id && d.projectSlug === projectSlug)
  return draft?.prompt === prompt ? draft.generatedTitle : undefined
}

/** The snapshot feed: every project's drafts not being launched, oldest
 *  first. */
export async function listDraftWorkspaces(): Promise<DraftWorkspaceEntry[]> {
  return (await listDraftWorkspaceRows()).filter((d) => !launching.has(d.id)).map(toEntry)
}

function toEntry({ createdAt, updatedAt, ...rest }: DraftWorkspaceRow): DraftWorkspaceEntry {
  return {
    ...rest,
    createdAt: formatUtcTimestamp(createdAt.getTime()),
    updatedAt: formatUtcTimestamp(updatedAt.getTime()),
  }
}
