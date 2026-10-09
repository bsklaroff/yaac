import { and, asc, eq, isNull } from 'drizzle-orm'
import { getDb } from './client'
import { draftWorkspaces } from './schema'
import { notifyWorkspaceListChanged } from '#notify'
import { isUuid } from '#lib/uuid'
import { nullsToUndefined, type NullsToUndefined } from '#lib/nulls'
import type { DraftWorkspaceSettings } from '@yaac/shared/types'

/**
 * Draft workspaces: create-dialog contents saved instead of run
 * (docs/draft-workspaces.md). Nothing observes a draft, so every write here
 * notifies the snapshot hub itself.
 */

type Row = typeof draftWorkspaces.$inferSelect

/** A draft (columns documented in schema.ts). */
export type DraftWorkspaceRow = NullsToUndefined<Row>

const toRow = (r: Row): DraftWorkspaceRow => nullsToUndefined(r)

/** Every column a save writes: an absent optional is stored as null, so a
 *  save replaces the whole draft rather than merging into it. */
function columns(s: DraftWorkspaceSettings): Omit<typeof draftWorkspaces.$inferInsert, 'projectId'> {
  return {
    prompt: s.prompt,
    tool: s.tool,
    mode: s.mode,
    permissionMode: s.permissionMode,
    model: s.model ?? null,
    effort: s.effort ?? null,
    branch: s.branch ?? null,
    startAfter: s.startAfter ?? null,
    title: s.title ?? null,
    groupId: s.groupId ?? null,
  }
}

export async function insertDraftWorkspace(
  projectId: string,
  settings: DraftWorkspaceSettings,
): Promise<DraftWorkspaceRow> {
  const db = await getDb()
  const [row] = await db.insert(draftWorkspaces).values({ projectId, ...columns(settings) }).returning()
  notifyWorkspaceListChanged()
  return toRow(row)
}

/**
 * Replace a draft's settings. A changed prompt clears the generated title.
 * Returns undefined if the project has no such draft (for example, it was
 * discarded since the dialog opened).
 */
export async function updateDraftWorkspace(
  projectId: string,
  id: string,
  settings: DraftWorkspaceSettings,
): Promise<DraftWorkspaceRow | undefined> {
  if (!isUuid(id)) return undefined
  const db = await getDb()
  const rows = await db.transaction(async (tx) => {
    const [prev] = await tx.select().from(draftWorkspaces)
      .where(and(eq(draftWorkspaces.id, id), eq(draftWorkspaces.projectId, projectId)))
    if (!prev) return []
    return await tx.update(draftWorkspaces)
      .set({
        ...columns(settings),
        updatedAt: new Date(),
        ...(prev.prompt !== settings.prompt ? { generatedTitle: null } : {}),
      })
      .where(eq(draftWorkspaces.id, id))
      .returning()
  })
  if (rows[0]) notifyWorkspaceListChanged()
  return rows[0] ? toRow(rows[0]) : undefined
}

/** Returns whether a draft was deleted. */
export async function deleteDraftWorkspace(id: string): Promise<boolean> {
  if (!isUuid(id)) return false
  const db = await getDb()
  const rows = await db.delete(draftWorkspaces).where(eq(draftWorkspaces.id, id)).returning()
  if (rows.length > 0) notifyWorkspaceListChanged()
  return rows.length > 0
}

/** Every project's drafts, oldest first. */
export async function listDraftWorkspaceRows(): Promise<DraftWorkspaceRow[]> {
  const db = await getDb()
  return (await db.select().from(draftWorkspaces).orderBy(asc(draftWorkspaces.createdAt))).map(toRow)
}

/**
 * Record a generated title, only if the draft has no title yet and still
 * holds the prompt the title was generated from (the prompt may have been
 * edited while the model ran).
 */
export async function setDraftWorkspaceTitle(id: string, prompt: string, title: string): Promise<void> {
  const db = await getDb()
  const rows = await db.update(draftWorkspaces)
    .set({ generatedTitle: title })
    .where(and(
      eq(draftWorkspaces.id, id),
      eq(draftWorkspaces.prompt, prompt),
      isNull(draftWorkspaces.title),
      isNull(draftWorkspaces.generatedTitle),
    ))
    .returning({ id: draftWorkspaces.id })
  if (rows.length > 0) notifyWorkspaceListChanged()
}

/** Delete a project's drafts when the project is removed. */
export async function deleteProjectDraftWorkspaces(projectId: string): Promise<void> {
  const db = await getDb()
  await db.delete(draftWorkspaces).where(eq(draftWorkspaces.projectId, projectId))
}
