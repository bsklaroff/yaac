import { and, asc, eq, isNull } from 'drizzle-orm'
import { getDb } from './client'
import { draftWorktrees } from './schema'
import { notifyWorktreeListChanged } from '#notify'
import { isUuid } from '#lib/uuid'
import type { AgentMode, AgentTool, DraftWorktreeSettings, PermissionMode } from '@yaac/shared/types'

/**
 * Draft worktrees: create-dialog contents the user kept instead of running
 * (docs/draft-worktrees.md). Pure intent, like groups — nothing observes a
 * draft, so every write here notifies the snapshot hub itself.
 */

export interface DraftWorktreeRow extends DraftWorktreeSettings {
  id: string
  projectSlug: string
  title?: string
  createdAt: Date
  updatedAt: Date
}

type Row = typeof draftWorktrees.$inferSelect

function toRow(r: Row): DraftWorktreeRow {
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
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

/** Every column a save writes: an absent optional is stored as null, so a
 *  save replaces the whole draft rather than merging into it. */
function columns(s: DraftWorktreeSettings): Omit<typeof draftWorktrees.$inferInsert, 'projectSlug'> {
  return {
    prompt: s.prompt,
    tool: s.tool,
    mode: s.mode,
    permissionMode: s.permissionMode,
    model: s.model ?? null,
    branch: s.branch ?? null,
    startAfter: s.startAfter ?? null,
  }
}

export async function insertDraftWorktree(
  projectSlug: string,
  settings: DraftWorktreeSettings,
): Promise<DraftWorktreeRow> {
  const db = await getDb()
  const [row] = await db.insert(draftWorktrees).values({ projectSlug, ...columns(settings) }).returning()
  notifyWorktreeListChanged()
  return toRow(row)
}

/**
 * Replace one of a project's drafts' settings. A changed prompt drops the
 * generated title, which described the old one. Answers undefined when the
 * project has no such draft — it was discarded, or created from, since the
 * dialog opened.
 */
export async function updateDraftWorktree(
  projectSlug: string,
  id: string,
  settings: DraftWorktreeSettings,
): Promise<DraftWorktreeRow | undefined> {
  // Draft ids are uuids; anything else names no draft.
  if (!isUuid(id)) return undefined
  const db = await getDb()
  const rows = await db.transaction(async (tx) => {
    const [prev] = await tx.select().from(draftWorktrees)
      .where(and(eq(draftWorktrees.id, id), eq(draftWorktrees.projectSlug, projectSlug)))
    if (!prev) return []
    return await tx.update(draftWorktrees)
      .set({
        ...columns(settings),
        updatedAt: new Date(),
        ...(prev.prompt !== settings.prompt ? { title: null } : {}),
      })
      .where(eq(draftWorktrees.id, id))
      .returning()
  })
  if (rows[0]) notifyWorktreeListChanged()
  return rows[0] ? toRow(rows[0]) : undefined
}

/** Answers whether there was one to delete. */
export async function deleteDraftWorktree(id: string): Promise<boolean> {
  if (!isUuid(id)) return false
  const db = await getDb()
  const rows = await db.delete(draftWorktrees).where(eq(draftWorktrees.id, id)).returning()
  if (rows.length > 0) notifyWorktreeListChanged()
  return rows.length > 0
}

/** Every project's drafts, oldest first. */
export async function listDraftWorktreeRows(): Promise<DraftWorktreeRow[]> {
  const db = await getDb()
  return (await db.select().from(draftWorktrees).orderBy(asc(draftWorktrees.createdAt))).map(toRow)
}

/**
 * Record a generated title — only while the draft is untitled and still
 * holds the prompt it was generated from, so an edit that lands while the
 * model runs is not labelled with a summary of what it replaced.
 */
export async function setDraftWorktreeTitle(id: string, prompt: string, title: string): Promise<void> {
  const db = await getDb()
  const rows = await db.update(draftWorktrees)
    .set({ title })
    .where(and(eq(draftWorktrees.id, id), eq(draftWorktrees.prompt, prompt), isNull(draftWorktrees.title)))
    .returning({ id: draftWorktrees.id })
  if (rows.length > 0) notifyWorktreeListChanged()
}

/** Forget a project's drafts — the project going away. */
export async function deleteProjectDraftWorktrees(projectSlug: string): Promise<void> {
  const db = await getDb()
  await db.delete(draftWorktrees).where(eq(draftWorktrees.projectSlug, projectSlug))
}
