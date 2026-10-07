/**
 * Draft workspaces (docs/draft-workspaces.md): create-dialog contents the
 * user chose to keep. Nothing runs from a draft; creating or queueing from
 * it discards it.
 */
import { notifyWorkspaceListChanged } from '#notify'
import { serverLog } from '#log'
import {
  deleteDraftWorkspace,
  getProjectRow,
  insertDraftWorkspace,
  listDraftWorkspaceRows,
  updateDraftWorkspace,
  type DraftWorkspaceRow,
} from '#db'
import { authorizeProject, type Actor } from '#domain/access'
import { ServerError } from '@yaac/shared/errors'
import { formatUtcTimestamp } from '@yaac/shared/time'
import { normalizeTitle } from '@yaac/shared/titles'
import type { DraftWorkspaceEntry, DraftWorkspaceSettings } from '@yaac/shared/types'

/** Save a new draft, or replace draft `id`'s settings. A blank title leaves
 *  the draft to be auto-titled. */
export async function saveDraftWorkspace(
  principal: Actor,
  projectId: string,
  { title, ...rest }: DraftWorkspaceSettings,
  id?: string,
): Promise<DraftWorkspaceEntry> {
  if (!await getProjectRow(projectId)) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  await authorizeProject(principal, projectId)
  const named = normalizeTitle(title ?? '')
  const settings = { ...rest, ...(named !== '' ? { title: named } : {}) }
  const row = id === undefined
    ? await insertDraftWorkspace(projectId, settings)
    : await updateDraftWorkspace(projectId, id, settings)
  if (!row) throw new ServerError('NOT_FOUND', `project ${projectId} has no draft workspace ${id}`)
  return toEntry(row)
}

/** Drafts a create or queue is being made from, left out of the snapshot
 *  until it succeeds (deleting the draft) or fails (showing it again). */
const launching = new Set<string>()

/** A create or queue's hold on the draft it is made from. */
export interface DraftClaim {
  /** The draft's generated title, if its prompt is still `prompt`. Reused
   *  by what is made from it instead of titling again. */
  generatedTitle: (prompt: string | undefined) => string | undefined
  /** Run the create or queue, then delete the draft. A failure keeps it.
   *  Either way the claim is released. */
  run: <T>(fn: () => Promise<T>) => Promise<T>
  /** Release without running, for a request refused before it starts. */
  release: () => void
}

const NO_DRAFT: DraftClaim = { generatedTitle: () => undefined, run: (fn) => fn(), release: () => {} }

/**
 * Claim draft `id` (none if undefined) for one create or queue. A draft
 * already claimed is a `CONFLICT` and one that is gone is `NOT_FOUND`, so
 * a second tab, a retry or a double click cannot make two workspaces from
 * one draft. A caller who does not own the project is refused even with no
 * draft, since the create and queue routes claim before anything else.
 */
export async function claimDraft(principal: Actor, projectId: string, id: string | undefined): Promise<DraftClaim> {
  await authorizeProject(principal, projectId)
  if (id === undefined) return NO_DRAFT
  if (launching.has(id)) throw new ServerError('CONFLICT', `draft workspace ${id} is already being created from`)
  launching.add(id)
  const draft = (await listDraftWorkspaceRows()).find((d) => d.id === id && d.projectId === projectId)
  if (!draft) {
    launching.delete(id)
    throw new ServerError('NOT_FOUND', `project ${projectId} has no draft workspace ${id}`)
  }
  notifyWorkspaceListChanged()
  const release = (): void => {
    if (launching.delete(id)) notifyWorkspaceListChanged()
  }
  return {
    generatedTitle: (prompt) => draft.prompt === prompt ? draft.generatedTitle : undefined,
    release,
    run: async (fn) => {
      try {
        const result = await fn()
        // The workspace or entry exists, so a left-over draft is the lesser
        // problem than reporting the request failed.
        await deleteDraftWorkspace(id).catch((err: unknown) =>
          serverLog(`[drafts] deleting draft ${id.slice(0, 8)}... once used failed: ${String(err)}`))
        return result
      } finally {
        release()
      }
    },
  }
}

export async function discardDraftWorkspace(principal: Actor, id: string): Promise<void> {
  const draft = (await listDraftWorkspaceRows()).find((d) => d.id === id)
  if (draft) await authorizeProject(principal, draft.projectId)
  if (!await deleteDraftWorkspace(id)) throw new ServerError('NOT_FOUND', `draft workspace ${id} not found`)
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
