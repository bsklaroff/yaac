import { and, asc, eq, isNull } from 'drizzle-orm'
import { getDb } from './client'
import { queuedWorkspaces } from './schema'
import { notifyWorkspaceListChanged } from '#notify'
import { isUuid } from '#lib/uuid'
import { ServerError } from '@yaac/shared/errors'
import type { AgentMode, AgentTool, PermissionMode } from '@yaac/shared/types'

/**
 * Queued workspaces: create requests saved to run when their parent stops
 * naturally (docs/queued-workspaces.md).
 *
 * Pure intent, like groups — nothing observes an entry, so every write here
 * notifies the snapshot hub itself. The writes below are the only way into
 * the table, and each keeps exactly one parent column set: an entry waits on
 * a workspace or on another entry, never both and never neither.
 *
 * An entry whose `launchWorkspaceId` is set is mid-launch, and that column is
 * the claim: every edit is guarded on it being null, so nothing can change
 * or remove an entry out from under the create that is running it.
 *
 * A launch that succeeds leaves its entry in the table as a record, with
 * `launchedWorkspaceId` naming what it became. It keeps its claim, so the
 * edit guard shuts it out; the writes that reach it through another entry
 * (re-pointing or splicing that entry's children) filter it, as every read
 * here does — to everything above the store it is gone.
 */

/** What an entry waits on — exactly one of the two. */
export type QueuedParent = { parentWorkspaceId: string } | { parentQueuedId: string }

/** An entry as the domain consumes it. */
export interface QueuedWorkspaceRow {
  id: string
  projectSlug: string
  parentWorkspaceId?: string
  parentQueuedId?: string
  createdAt: Date
  prompt: string
  tool: AgentTool
  model: string
  mode: AgentMode
  permissionMode: PermissionMode
  branch: string
  title?: string
  generatedTitle?: string
  groupId?: string
  releasedAt?: Date
  launchWorkspaceId?: string
  launchError?: string
}

/** The stored settings of an entry — what an insert takes and an update
 *  replaces. An absent title or group is stored as none. */
export interface QueuedWorkspaceSettings {
  prompt: string
  tool: AgentTool
  model: string
  mode: AgentMode
  permissionMode: PermissionMode
  branch: string
  title?: string
  groupId?: string
}

type Row = typeof queuedWorkspaces.$inferSelect

function toRow(r: Row): QueuedWorkspaceRow {
  return {
    id: r.id,
    projectSlug: r.projectSlug,
    ...(r.parentWorkspaceId !== null ? { parentWorkspaceId: r.parentWorkspaceId } : {}),
    ...(r.parentQueuedId !== null ? { parentQueuedId: r.parentQueuedId } : {}),
    createdAt: r.createdAt,
    prompt: r.prompt,
    tool: r.tool as AgentTool,
    model: r.model,
    mode: r.mode as AgentMode,
    permissionMode: r.permissionMode as PermissionMode,
    branch: r.branch,
    ...(r.title !== null ? { title: r.title } : {}),
    ...(r.generatedTitle !== null ? { generatedTitle: r.generatedTitle } : {}),
    ...(r.groupId !== null ? { groupId: r.groupId } : {}),
    ...(r.releasedAt !== null ? { releasedAt: r.releasedAt } : {}),
    ...(r.launchWorkspaceId !== null ? { launchWorkspaceId: r.launchWorkspaceId } : {}),
    ...(r.launchError !== null ? { launchError: r.launchError } : {}),
  }
}

/** Both parent columns, one set and the other cleared. */
function parentColumns(parent: QueuedParent): { parentWorkspaceId: string | null; parentQueuedId: string | null } {
  return 'parentWorkspaceId' in parent
    ? { parentWorkspaceId: parent.parentWorkspaceId, parentQueuedId: null }
    : { parentWorkspaceId: null, parentQueuedId: parent.parentQueuedId }
}

/** Every settings column, an absent title or group as null. */
function settingsColumns(s: QueuedWorkspaceSettings): Omit<typeof queuedWorkspaces.$inferInsert, 'projectSlug'> {
  return { ...s, title: s.title ?? null, groupId: s.groupId ?? null }
}

/** Not mid-launch — the guard on every edit. */
const notLaunching = isNull(queuedWorkspaces.launchWorkspaceId)

/** Not launched yet — the filter on every read. */
const pending = isNull(queuedWorkspaces.launchedWorkspaceId)

/** `generatedTitle` is one made for the draft the entry came from. */
export async function insertQueuedWorkspace(
  projectSlug: string,
  parent: QueuedParent,
  settings: QueuedWorkspaceSettings,
  generatedTitle?: string,
): Promise<QueuedWorkspaceRow> {
  const db = await getDb()
  const [row] = await db.insert(queuedWorkspaces)
    .values({
      projectSlug,
      ...parentColumns(parent),
      ...settingsColumns(settings),
      generatedTitle: generatedTitle ?? null,
    })
    .returning()
  notifyWorkspaceListChanged()
  return toRow(row)
}

/**
 * Replace an entry's settings — all of them — and, when given, its parent.
 * A changed prompt drops the generated title, which described the old one.
 * Answers the updated entry, or undefined when there is none to update — it
 * is gone, or mid-launch.
 *
 * A new parent that is the entry itself or sits below it would close a cycle
 * that never runs, and is refused (VALIDATION). The walk goes up from the new
 * parent, stepping from a workspace that is some entry's launch to that entry
 * — a launching entry hides its ancestry otherwise, and a failed launch would
 * close the cycle the walk missed. It runs in the same transaction as the
 * write, so two edits moving A under B and B under A cannot both pass.
 */
export async function updateQueuedWorkspace(
  id: string,
  patch: QueuedWorkspaceSettings & { parent?: QueuedParent },
): Promise<QueuedWorkspaceRow | undefined> {
  const { parent, ...settings } = patch
  const db = await getDb()
  const rows = await db.transaction(async (tx) => {
    const [self] = await tx.select().from(queuedWorkspaces).where(eq(queuedWorkspaces.id, id))
    if (!self) return []
    if (parent !== undefined) {
      const entries = (await tx.select().from(queuedWorkspaces)
        .where(and(eq(queuedWorkspaces.projectSlug, self.projectSlug), pending))).map(toRow)
      if (closesCycle(id, parent, entries)) {
        throw new ServerError('VALIDATION', 'a queued workspace cannot wait on itself or on one queued after it')
      }
    }
    return await tx.update(queuedWorkspaces)
      .set({
        ...settingsColumns(settings),
        ...(parent !== undefined ? parentColumns(parent) : {}),
        ...(self.prompt !== settings.prompt ? { generatedTitle: null } : {}),
      })
      .where(and(eq(queuedWorkspaces.id, id), notLaunching))
      .returning()
  })
  notifyWorkspaceListChanged()
  return rows[0] ? toRow(rows[0]) : undefined
}

/** Whether pointing entry `id` at `parent` puts `id` above itself. */
function closesCycle(id: string, parent: QueuedParent, entries: QueuedWorkspaceRow[]): boolean {
  const byId = new Map(entries.map((e) => [e.id, e]))
  const byLaunch = new Map(entries.flatMap((e) =>
    e.launchWorkspaceId !== undefined ? [[e.launchWorkspaceId, e] as const] : []))
  const seen = new Set<string>()
  let cur: QueuedParent = parent
  for (;;) {
    const next: QueuedWorkspaceRow | undefined = 'parentQueuedId' in cur
      ? byId.get(cur.parentQueuedId)
      : byLaunch.get(cur.parentWorkspaceId)
    if (next === undefined || seen.has(next.id)) return false
    if (next.id === id) return true
    seen.add(next.id)
    cur = next.parentQueuedId !== undefined
      ? { parentQueuedId: next.parentQueuedId }
      : { parentWorkspaceId: next.parentWorkspaceId ?? '' }
  }
}

/**
 * Delete an entry, splicing its children up to its own parent in the same
 * transaction so none is left waiting on an entry that no longer exists.
 * Answers whether there was one to delete (absent, or mid-launch: false).
 */
export async function deleteQueuedWorkspace(id: string): Promise<boolean> {
  const db = await getDb()
  const deleted = await db.transaction(async (tx) => {
    const [row] = await tx.delete(queuedWorkspaces)
      .where(and(eq(queuedWorkspaces.id, id), notLaunching))
      .returning()
    if (!row) return false
    await tx.update(queuedWorkspaces)
      .set({ parentWorkspaceId: row.parentWorkspaceId, parentQueuedId: row.parentQueuedId })
      .where(and(eq(queuedWorkspaces.parentQueuedId, id), pending))
    return true
  })
  if (deleted) notifyWorkspaceListChanged()
  return deleted
}

export async function getQueuedWorkspaceRow(id: string): Promise<QueuedWorkspaceRow | undefined> {
  // Entry ids are uuids; anything else names no entry.
  if (!isUuid(id)) return undefined
  const db = await getDb()
  const rows = await db.select().from(queuedWorkspaces).where(and(eq(queuedWorkspaces.id, id), pending))
  return rows[0] ? toRow(rows[0]) : undefined
}

/** Every entry of a project (or of all), oldest first — launching ones too. */
export async function listQueuedWorkspaceRows(projectSlug?: string): Promise<QueuedWorkspaceRow[]> {
  const db = await getDb()
  const rows = await db.select().from(queuedWorkspaces)
    .where(projectSlug === undefined ? pending : and(eq(queuedWorkspaces.projectSlug, projectSlug), pending))
    .orderBy(asc(queuedWorkspaces.createdAt))
  return rows.map(toRow)
}

/**
 * Record a generated title — only while the entry is untitled, by the user
 * or the model, still holds the prompt it was generated from, and is not
 * mid-launch, so an edit that lands while the model runs is not labelled
 * with a summary of what it replaced.
 */
export async function setQueuedWorkspaceTitle(id: string, prompt: string, title: string): Promise<void> {
  const db = await getDb()
  const rows = await db.update(queuedWorkspaces)
    .set({ generatedTitle: title })
    .where(and(
      eq(queuedWorkspaces.id, id),
      eq(queuedWorkspaces.prompt, prompt),
      isNull(queuedWorkspaces.title),
      isNull(queuedWorkspaces.generatedTitle),
      notLaunching,
    ))
    .returning({ id: queuedWorkspaces.id })
  if (rows.length > 0) notifyWorkspaceListChanged()
}

/**
 * Release every entry waiting directly on a workspace — its natural stop.
 * Clears a previous launch's error, since this is the next attempt. An entry
 * already mid-launch is left alone. Answers what was released.
 */
export async function releaseQueuedChildren(
  projectSlug: string,
  workspaceId: string,
): Promise<QueuedWorkspaceRow[]> {
  const db = await getDb()
  const rows = await db.update(queuedWorkspaces)
    .set({ releasedAt: new Date(), launchError: null })
    .where(and(
      eq(queuedWorkspaces.projectSlug, projectSlug),
      eq(queuedWorkspaces.parentWorkspaceId, workspaceId),
      notLaunching,
    ))
    .returning()
  if (rows.length > 0) notifyWorkspaceListChanged()
  return rows.map(toRow)
}

/** Release one entry, whatever its parent is doing — Run now. */
export async function releaseQueuedWorkspace(id: string): Promise<QueuedWorkspaceRow | undefined> {
  const db = await getDb()
  const rows = await db.update(queuedWorkspaces)
    .set({ releasedAt: new Date(), launchError: null })
    .where(and(eq(queuedWorkspaces.id, id), notLaunching))
    .returning()
  notifyWorkspaceListChanged()
  return rows[0] ? toRow(rows[0]) : undefined
}

/**
 * Claim an entry's launch under the workspace id it will create — a
 * compare-and-set, so of two launchers racing for one entry exactly one
 * wins. The winner's children are re-pointed at that workspace in the same
 * transaction: from here on they are ordinary children of a workspace, and
 * its natural stop releases them.
 */
export async function claimQueuedLaunch(id: string, workspaceId: string): Promise<boolean> {
  const db = await getDb()
  const claimed = await db.transaction(async (tx) => {
    const rows = await tx.update(queuedWorkspaces)
      .set({ launchWorkspaceId: workspaceId })
      .where(and(eq(queuedWorkspaces.id, id), notLaunching))
      .returning({ id: queuedWorkspaces.id })
    if (rows.length === 0) return false
    await tx.update(queuedWorkspaces)
      .set({ parentWorkspaceId: workspaceId, parentQueuedId: null })
      .where(and(eq(queuedWorkspaces.parentQueuedId, id), pending))
    return true
  })
  if (claimed) notifyWorkspaceListChanged()
  return claimed
}

/** Claimed by exactly this launch, and not resolved yet — the guard on
 *  resolving one, so a caller holding a stale view of the claim (a
 *  reconcile pass racing a Run now) changes nothing. */
const claimedBy = (id: string, workspaceId: string) =>
  and(eq(queuedWorkspaces.id, id), eq(queuedWorkspaces.launchWorkspaceId, workspaceId), pending)

/**
 * The launch under `workspaceId` succeeded: the entry is a workspace now, and
 * stays behind only as the record of what that workspace was queued as. Any
 * child still pointing at the entry — none should, since the claim re-pointed
 * them — follows it to that workspace, so no path leaves one waiting on an
 * entry that is gone.
 */
export async function finishQueuedLaunch(id: string, workspaceId: string): Promise<void> {
  const db = await getDb()
  await db.transaction(async (tx) => {
    const launched = await tx.update(queuedWorkspaces)
      .set({ launchedWorkspaceId: workspaceId })
      .where(claimedBy(id, workspaceId))
      .returning({ id: queuedWorkspaces.id })
    if (launched.length === 0) return
    await tx.update(queuedWorkspaces)
      .set({ parentWorkspaceId: workspaceId, parentQueuedId: null })
      .where(and(eq(queuedWorkspaces.parentQueuedId, id), pending))
  })
  notifyWorkspaceListChanged()
}

/**
 * The launch under `workspaceId` failed: the entry goes back in the queue,
 * unreleased and carrying why, and every child of that workspace that has not
 * been released comes back under it — including one queued under it while
 * the launch was in flight. A child the workspace's own stop already released
 * keeps its pointer: a release is never taken back. A no-op unless the entry
 * is still claimed by that launch.
 */
export async function failQueuedLaunch(id: string, workspaceId: string, error: string): Promise<void> {
  const db = await getDb()
  await db.transaction(async (tx) => {
    const [row] = await tx.update(queuedWorkspaces)
      .set({ launchWorkspaceId: null, releasedAt: null, launchError: error })
      .where(claimedBy(id, workspaceId))
      .returning()
    if (!row) return
    await tx.update(queuedWorkspaces)
      .set({ parentWorkspaceId: null, parentQueuedId: id })
      .where(and(
        eq(queuedWorkspaces.projectSlug, row.projectSlug),
        eq(queuedWorkspaces.parentWorkspaceId, workspaceId),
        isNull(queuedWorkspaces.releasedAt),
        notLaunching,
      ))
  })
  notifyWorkspaceListChanged()
}

/** Forget a project's entries, launched ones too — the project going away. */
export async function deleteProjectQueuedWorkspaces(projectSlug: string): Promise<void> {
  const db = await getDb()
  await db.delete(queuedWorkspaces).where(eq(queuedWorkspaces.projectSlug, projectSlug))
}
