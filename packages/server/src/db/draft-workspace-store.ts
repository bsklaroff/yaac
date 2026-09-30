import { and, asc, eq, isNull } from 'drizzle-orm'
import { getDb } from './client'
import { draftWorkspaces } from './schema'
import { notifyWorkspaceListChanged } from '#notify'
import { isUuid } from '#lib/uuid'
import type { AgentMode, AgentTool, DraftWorkspaceSettings, PermissionMode } from '@yaac/shared/types'

/**
 * Draft workspaces: create-dialog contents the user kept instead of running
 * (docs/draft-workspaces.md). Pure intent, like groups — nothing observes a
 * draft, so every write here notifies the snapshot hub itself.
 */

export interface DraftWorkspaceRow extends DraftWorkspaceSettings {
  id: string
  projectSlug: string
  generatedTitle?: string
  createdAt: Date
  updatedAt: Date
}

type Row = typeof draftWorkspaces.$inferSelect

function toRow(r: Row): DraftWorkspaceRow {
  return {
    id: r.id,
    projectSlug: r.projectSlug,
    prompt: r.prompt,
    tool: r.tool as AgentTool,
    mode: r.mode as AgentMode,
    permissionMode: r.permissionMode as PermissionMode,
    ...(r.model !== null ? { model: r.model } : {}),
    ...(r.branch !== null ? { branch: r.branch } : {}),
    ...(r.startAfter !== null ? { startAfter: r.startAfter } : {}),
    ...(r.title !== null ? { title: r.title } : {}),
    ...(r.groupId !== null ? { groupId: r.groupId } : {}),
    ...(r.generatedTitle !== null ? { generatedTitle: r.generatedTitle } : {}),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

/** Every column a save writes: an absent optional is stored as null, so a
 *  save replaces the whole draft rather than merging into it. */
function columns(s: DraftWorkspaceSettings): Omit<typeof draftWorkspaces.$inferInsert, 'projectSlug'> {
  return {
    prompt: s.prompt,
    tool: s.tool,
    mode: s.mode,
    permissionMode: s.permissionMode,
    model: s.model ?? null,
    branch: s.branch ?? null,
    startAfter: s.startAfter ?? null,
    title: s.title ?? null,
    groupId: s.groupId ?? null,
  }
}

export async function insertDraftWorkspace(
  projectSlug: string,
  settings: DraftWorkspaceSettings,
): Promise<DraftWorkspaceRow> {
  const db = await getDb()
  const [row] = await db.insert(draftWorkspaces).values({ projectSlug, ...columns(settings) }).returning()
  notifyWorkspaceListChanged()
  return toRow(row)
}

/**
 * Replace one of a project's drafts' settings. A changed prompt drops the
 * generated title, which described the old one. Answers undefined when the
 * project has no such draft — it was discarded, or created from, since the
 * dialog opened.
 */
export async function updateDraftWorkspace(
  projectSlug: string,
  id: string,
  settings: DraftWorkspaceSettings,
): Promise<DraftWorkspaceRow | undefined> {
  // Draft ids are uuids; anything else names no draft.
  if (!isUuid(id)) return undefined
  const db = await getDb()
  const rows = await db.transaction(async (tx) => {
    const [prev] = await tx.select().from(draftWorkspaces)
      .where(and(eq(draftWorkspaces.id, id), eq(draftWorkspaces.projectSlug, projectSlug)))
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

/** Answers whether there was one to delete. */
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
 * Record a generated title — only while the draft is untitled, by the user
 * or the model, and still holds the prompt it was generated from, so an edit
 * that lands while the model runs is not labelled with a summary of what it
 * replaced.
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

/** Forget a project's drafts — the project going away. */
export async function deleteProjectDraftWorkspaces(projectSlug: string): Promise<void> {
  const db = await getDb()
  await db.delete(draftWorkspaces).where(eq(draftWorkspaces.projectSlug, projectSlug))
}
