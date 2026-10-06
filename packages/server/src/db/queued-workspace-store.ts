import { and, asc, eq, isNull } from 'drizzle-orm'
import { getDb } from './client'
import { queuedWorkspaces } from './schema'
import { notifyWorkspaceListChanged } from '#notify'
import { isUuid } from '#lib/uuid'
import { nullsToUndefined, type NullsToUndefined } from '#lib/nulls'
import { ServerError } from '@yaac/shared/errors'
import type { AgentMode, AgentTool, PermissionMode } from '@yaac/shared/types'

/**
 * Queued workspaces: create requests saved to run when their parent stops
 * naturally (docs/queued-workspaces.md).
 *
 * Nothing observes an entry, so every write here notifies the snapshot hub
 * itself. Every write keeps exactly one parent column set: an entry waits on
 * a workspace or on another entry.
 *
 * A set `launchWorkspaceId` means the entry is mid-launch. Every edit
 * requires it to be null, so nothing changes an entry under a running create.
 *
 * A successful launch leaves the entry as a record, with
 * `launchedWorkspaceId` naming the workspace. It keeps its claim, so edits
 * skip it, and every read here filters it out.
 */

/** What an entry waits on: a workspace or another entry. */
export type QueuedParent = { parentWorkspaceId: string } | { parentQueuedId: string }

/** An entry's settings: what an insert takes and an update replaces. An
 *  absent title or group is stored as null. */
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

/** A pending entry (columns documented in schema.ts). */
export type QueuedWorkspaceRow = NullsToUndefined<Omit<Row, 'launchedWorkspaceId'>>

function toRow({ launchedWorkspaceId: _, ...r }: Row): QueuedWorkspaceRow {
  return nullsToUndefined(r)
}

/** Both parent columns: one set, the other null. */
function parentColumns(parent: QueuedParent): { parentWorkspaceId: string | null; parentQueuedId: string | null } {
  return 'parentWorkspaceId' in parent
    ? { parentWorkspaceId: parent.parentWorkspaceId, parentQueuedId: null }
    : { parentWorkspaceId: null, parentQueuedId: parent.parentQueuedId }
}

function settingsColumns(s: QueuedWorkspaceSettings): Omit<typeof queuedWorkspaces.$inferInsert, 'projectId'> {
  return { ...s, title: s.title ?? null, groupId: s.groupId ?? null }
}

/** Not mid-launch: the guard on every edit. */
const notLaunching = isNull(queuedWorkspaces.launchWorkspaceId)

/** Not launched yet: the filter on every read. */
const pending = isNull(queuedWorkspaces.launchedWorkspaceId)

/** `generatedTitle` is the one generated for the draft the entry came from. */
export async function insertQueuedWorkspace(
  projectId: string,
  parent: QueuedParent,
  settings: QueuedWorkspaceSettings,
  generatedTitle?: string,
): Promise<QueuedWorkspaceRow> {
  const db = await getDb()
  const [row] = await db.insert(queuedWorkspaces)
    .values({
      projectId,
      ...parentColumns(parent),
      ...settingsColumns(settings),
      generatedTitle: generatedTitle ?? null,
    })
    .returning()
  notifyWorkspaceListChanged()
  return toRow(row)
}

/**
 * Replace all of an entry's settings and, if given, its parent. A changed
 * prompt clears the generated title. Returns undefined if the entry is gone
 * or mid-launch.
 *
 * A new parent that is the entry itself or one of its descendants would form
 * a cycle and is refused (VALIDATION). The check walks up from the new
 * parent, stepping from a workspace to the entry launching it (otherwise a
 * failed launch could close a cycle the walk missed). It runs in the same
 * transaction as the write, so two concurrent edits can't create a cycle.
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
        .where(and(eq(queuedWorkspaces.projectId, self.projectId), pending))).map(toRow)
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
 * Delete an entry, moving its children up to its own parent in the same
 * transaction. Returns false if the entry is absent or mid-launch.
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
  if (!isUuid(id)) return undefined
  const db = await getDb()
  const rows = await db.select().from(queuedWorkspaces).where(and(eq(queuedWorkspaces.id, id), pending))
  return rows[0] ? toRow(rows[0]) : undefined
}

/** Every entry of a project (or of all), oldest first, including launching
 *  ones. */
export async function listQueuedWorkspaceRows(projectId?: string): Promise<QueuedWorkspaceRow[]> {
  const db = await getDb()
  const rows = await db.select().from(queuedWorkspaces)
    .where(projectId === undefined ? pending : and(eq(queuedWorkspaces.projectId, projectId), pending))
    .orderBy(asc(queuedWorkspaces.createdAt))
  return rows.map(toRow)
}

/**
 * Record a generated title, only if the entry has no title yet, still holds
 * the prompt the title was generated from, and is not mid-launch.
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
 * Release every entry waiting directly on a workspace, on its natural stop.
 * Clears any previous launch error; skips entries mid-launch. Returns the
 * released entries.
 */
export async function releaseQueuedChildren(
  projectId: string,
  workspaceId: string,
): Promise<QueuedWorkspaceRow[]> {
  const db = await getDb()
  const rows = await db.update(queuedWorkspaces)
    .set({ releasedAt: new Date(), launchError: null })
    .where(and(
      eq(queuedWorkspaces.projectId, projectId),
      eq(queuedWorkspaces.parentWorkspaceId, workspaceId),
      notLaunching,
    ))
    .returning()
  if (rows.length > 0) notifyWorkspaceListChanged()
  return rows.map(toRow)
}

/** Release one entry regardless of its parent ("Run now"). */
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
 * Claim an entry's launch under the workspace id it will create. A
 * compare-and-set, so only one of two racing launchers wins. The entry's
 * children are re-pointed at that workspace in the same transaction, so its
 * natural stop releases them.
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

/** Claimed by exactly this launch and not yet resolved. Guards resolution,
 *  so a caller with a stale view (a reconcile pass racing a "Run now")
 *  changes nothing. */
const claimedBy = (id: string, workspaceId: string) =>
  and(eq(queuedWorkspaces.id, id), eq(queuedWorkspaces.launchWorkspaceId, workspaceId), pending)

/**
 * The launch under `workspaceId` succeeded. The entry stays only as a record.
 * Any child still pointing at it (none should, since the claim re-pointed
 * them) is moved to the workspace.
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
 * The launch under `workspaceId` failed, or was stopped (no error). The
 * entry returns to the queue, unreleased and with the error, and the workspace's unreleased children
 * (including any queued during the launch) move back under it. Already
 * released children stay put. A no-op unless the entry is still claimed by
 * this launch.
 */
export async function failQueuedLaunch(id: string, workspaceId: string, error: string | null): Promise<void> {
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
        eq(queuedWorkspaces.projectId, row.projectId),
        eq(queuedWorkspaces.parentWorkspaceId, workspaceId),
        isNull(queuedWorkspaces.releasedAt),
        notLaunching,
      ))
  })
  notifyWorkspaceListChanged()
}

/** Delete all of a project's entries, launched ones too, on project removal. */
export async function deleteProjectQueuedWorkspaces(projectId: string): Promise<void> {
  const db = await getDb()
  await db.delete(queuedWorkspaces).where(eq(queuedWorkspaces.projectId, projectId))
}
