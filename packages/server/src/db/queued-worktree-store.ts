import { and, asc, eq, isNull } from 'drizzle-orm'
import { getDb } from './client'
import { queuedWorktrees } from './schema'
import { notifyWorktreeListChanged } from '#notify'
import { isUuid } from '#lib/uuid'
import { ServerError } from '@yaac/shared/errors'
import type { AgentMode, AgentTool, PermissionMode } from '@yaac/shared/types'

/**
 * Queued worktrees: create requests saved to run when their parent stops
 * naturally (docs/queued-worktrees.md).
 *
 * Pure intent, like groups — nothing observes an entry, so every write here
 * notifies the snapshot hub itself. The writes below are the only way into
 * the table, and each keeps exactly one parent column set: an entry waits on
 * a worktree or on another entry, never both and never neither.
 *
 * An entry whose `launchWorktreeId` is set is mid-launch, and that column is
 * the claim: every edit is guarded on it being null, so nothing can change
 * or remove an entry out from under the create that is running it.
 *
 * A launch that succeeds leaves its entry in the table as a record, with
 * `launchedWorktreeId` naming what it became. It keeps its claim, so the
 * edit guard shuts it out; the writes that reach it through another entry
 * (re-pointing or splicing that entry's children) filter it, as every read
 * here does — to everything above the store it is gone.
 */

/** What an entry waits on — exactly one of the two. */
export type QueuedParent = { parentWorktreeId: string } | { parentQueuedId: string }

/** An entry as the domain consumes it. */
export interface QueuedWorktreeRow {
  id: string
  projectSlug: string
  parentWorktreeId?: string
  parentQueuedId?: string
  createdAt: Date
  prompt: string
  tool: AgentTool
  model: string
  mode: AgentMode
  permissionMode: PermissionMode
  branch: string
  title?: string
  groupId?: string
  releasedAt?: Date
  launchWorktreeId?: string
  launchError?: string
}

/** The stored settings of an entry — what an insert takes and an update
 *  replaces. An absent title or group is stored as none. */
export interface QueuedWorktreeSettings {
  prompt: string
  tool: AgentTool
  model: string
  mode: AgentMode
  permissionMode: PermissionMode
  branch: string
  title?: string
  groupId?: string
}

type Row = typeof queuedWorktrees.$inferSelect

function toRow(r: Row): QueuedWorktreeRow {
  return {
    id: r.id,
    projectSlug: r.projectSlug,
    ...(r.parentWorktreeId !== null ? { parentWorktreeId: r.parentWorktreeId } : {}),
    ...(r.parentQueuedId !== null ? { parentQueuedId: r.parentQueuedId } : {}),
    createdAt: r.createdAt,
    prompt: r.prompt,
    tool: r.tool as AgentTool,
    model: r.model,
    mode: r.mode as AgentMode,
    permissionMode: r.permissionMode as PermissionMode,
    branch: r.branch,
    ...(r.title !== null ? { title: r.title } : {}),
    ...(r.groupId !== null ? { groupId: r.groupId } : {}),
    ...(r.releasedAt !== null ? { releasedAt: r.releasedAt } : {}),
    ...(r.launchWorktreeId !== null ? { launchWorktreeId: r.launchWorktreeId } : {}),
    ...(r.launchError !== null ? { launchError: r.launchError } : {}),
  }
}

/** Both parent columns, one set and the other cleared. */
function parentColumns(parent: QueuedParent): { parentWorktreeId: string | null; parentQueuedId: string | null } {
  return 'parentWorktreeId' in parent
    ? { parentWorktreeId: parent.parentWorktreeId, parentQueuedId: null }
    : { parentWorktreeId: null, parentQueuedId: parent.parentQueuedId }
}

/** Every settings column, an absent title or group as null. */
function settingsColumns(s: QueuedWorktreeSettings): Omit<typeof queuedWorktrees.$inferInsert, 'projectSlug'> {
  return { ...s, title: s.title ?? null, groupId: s.groupId ?? null }
}

/** Not mid-launch — the guard on every edit. */
const notLaunching = isNull(queuedWorktrees.launchWorktreeId)

/** Not launched yet — the filter on every read. */
const pending = isNull(queuedWorktrees.launchedWorktreeId)

export async function insertQueuedWorktree(
  projectSlug: string,
  parent: QueuedParent,
  settings: QueuedWorktreeSettings,
): Promise<QueuedWorktreeRow> {
  const db = await getDb()
  const [row] = await db.insert(queuedWorktrees)
    .values({ projectSlug, ...parentColumns(parent), ...settingsColumns(settings) })
    .returning()
  notifyWorktreeListChanged()
  return toRow(row)
}

/**
 * Replace an entry's settings — all of them — and, when given, its parent.
 * Answers the updated entry, or undefined when there is none to update — it
 * is gone, or mid-launch.
 *
 * A new parent that is the entry itself or sits below it would close a cycle
 * that never runs, and is refused (VALIDATION). The walk goes up from the new
 * parent, stepping from a worktree that is some entry's launch to that entry
 * — a launching entry hides its ancestry otherwise, and a failed launch would
 * close the cycle the walk missed. It runs in the same transaction as the
 * write, so two edits moving A under B and B under A cannot both pass.
 */
export async function updateQueuedWorktree(
  id: string,
  patch: QueuedWorktreeSettings & { parent?: QueuedParent },
): Promise<QueuedWorktreeRow | undefined> {
  const { parent, ...settings } = patch
  const db = await getDb()
  const rows = await db.transaction(async (tx) => {
    if (parent !== undefined) {
      const [self] = await tx.select().from(queuedWorktrees).where(eq(queuedWorktrees.id, id))
      if (!self) return []
      const entries = (await tx.select().from(queuedWorktrees)
        .where(and(eq(queuedWorktrees.projectSlug, self.projectSlug), pending))).map(toRow)
      if (closesCycle(id, parent, entries)) {
        throw new ServerError('VALIDATION', 'a queued worktree cannot wait on itself or on one queued after it')
      }
    }
    return await tx.update(queuedWorktrees)
      .set({ ...settingsColumns(settings), ...(parent !== undefined ? parentColumns(parent) : {}) })
      .where(and(eq(queuedWorktrees.id, id), notLaunching))
      .returning()
  })
  notifyWorktreeListChanged()
  return rows[0] ? toRow(rows[0]) : undefined
}

/** Whether pointing entry `id` at `parent` puts `id` above itself. */
function closesCycle(id: string, parent: QueuedParent, entries: QueuedWorktreeRow[]): boolean {
  const byId = new Map(entries.map((e) => [e.id, e]))
  const byLaunch = new Map(entries.flatMap((e) =>
    e.launchWorktreeId !== undefined ? [[e.launchWorktreeId, e] as const] : []))
  const seen = new Set<string>()
  let cur: QueuedParent = parent
  for (;;) {
    const next: QueuedWorktreeRow | undefined = 'parentQueuedId' in cur
      ? byId.get(cur.parentQueuedId)
      : byLaunch.get(cur.parentWorktreeId)
    if (next === undefined || seen.has(next.id)) return false
    if (next.id === id) return true
    seen.add(next.id)
    cur = next.parentQueuedId !== undefined
      ? { parentQueuedId: next.parentQueuedId }
      : { parentWorktreeId: next.parentWorktreeId ?? '' }
  }
}

/**
 * Delete an entry, splicing its children up to its own parent in the same
 * transaction so none is left waiting on an entry that no longer exists.
 * Answers whether there was one to delete (absent, or mid-launch: false).
 */
export async function deleteQueuedWorktree(id: string): Promise<boolean> {
  const db = await getDb()
  const deleted = await db.transaction(async (tx) => {
    const [row] = await tx.delete(queuedWorktrees)
      .where(and(eq(queuedWorktrees.id, id), notLaunching))
      .returning()
    if (!row) return false
    await tx.update(queuedWorktrees)
      .set({ parentWorktreeId: row.parentWorktreeId, parentQueuedId: row.parentQueuedId })
      .where(and(eq(queuedWorktrees.parentQueuedId, id), pending))
    return true
  })
  if (deleted) notifyWorktreeListChanged()
  return deleted
}

export async function getQueuedWorktreeRow(id: string): Promise<QueuedWorktreeRow | undefined> {
  // Entry ids are uuids; anything else names no entry.
  if (!isUuid(id)) return undefined
  const db = await getDb()
  const rows = await db.select().from(queuedWorktrees).where(and(eq(queuedWorktrees.id, id), pending))
  return rows[0] ? toRow(rows[0]) : undefined
}

/** Every entry of a project (or of all), oldest first — launching ones too. */
export async function listQueuedWorktreeRows(projectSlug?: string): Promise<QueuedWorktreeRow[]> {
  const db = await getDb()
  const rows = await db.select().from(queuedWorktrees)
    .where(projectSlug === undefined ? pending : and(eq(queuedWorktrees.projectSlug, projectSlug), pending))
    .orderBy(asc(queuedWorktrees.createdAt))
  return rows.map(toRow)
}

/**
 * Release every entry waiting directly on a worktree — its natural stop.
 * Clears a previous launch's error, since this is the next attempt. An entry
 * already mid-launch is left alone. Answers what was released.
 */
export async function releaseQueuedChildren(
  projectSlug: string,
  worktreeId: string,
): Promise<QueuedWorktreeRow[]> {
  const db = await getDb()
  const rows = await db.update(queuedWorktrees)
    .set({ releasedAt: new Date(), launchError: null })
    .where(and(
      eq(queuedWorktrees.projectSlug, projectSlug),
      eq(queuedWorktrees.parentWorktreeId, worktreeId),
      notLaunching,
    ))
    .returning()
  if (rows.length > 0) notifyWorktreeListChanged()
  return rows.map(toRow)
}

/** Release one entry, whatever its parent is doing — Run now. */
export async function releaseQueuedWorktree(id: string): Promise<QueuedWorktreeRow | undefined> {
  const db = await getDb()
  const rows = await db.update(queuedWorktrees)
    .set({ releasedAt: new Date(), launchError: null })
    .where(and(eq(queuedWorktrees.id, id), notLaunching))
    .returning()
  notifyWorktreeListChanged()
  return rows[0] ? toRow(rows[0]) : undefined
}

/**
 * Claim an entry's launch under the worktree id it will create — a
 * compare-and-set, so of two launchers racing for one entry exactly one
 * wins. The winner's children are re-pointed at that worktree in the same
 * transaction: from here on they are ordinary children of a worktree, and
 * its natural stop releases them.
 */
export async function claimQueuedLaunch(id: string, worktreeId: string): Promise<boolean> {
  const db = await getDb()
  const claimed = await db.transaction(async (tx) => {
    const rows = await tx.update(queuedWorktrees)
      .set({ launchWorktreeId: worktreeId })
      .where(and(eq(queuedWorktrees.id, id), notLaunching))
      .returning({ id: queuedWorktrees.id })
    if (rows.length === 0) return false
    await tx.update(queuedWorktrees)
      .set({ parentWorktreeId: worktreeId, parentQueuedId: null })
      .where(and(eq(queuedWorktrees.parentQueuedId, id), pending))
    return true
  })
  if (claimed) notifyWorktreeListChanged()
  return claimed
}

/** Claimed by exactly this launch, and not resolved yet — the guard on
 *  resolving one, so a caller holding a stale view of the claim (a
 *  reconcile pass racing a Run now) changes nothing. */
const claimedBy = (id: string, worktreeId: string) =>
  and(eq(queuedWorktrees.id, id), eq(queuedWorktrees.launchWorktreeId, worktreeId), pending)

/**
 * The launch under `worktreeId` succeeded: the entry is a worktree now, and
 * stays behind only as the record of what that worktree was queued as. Any
 * child still pointing at the entry — none should, since the claim re-pointed
 * them — follows it to that worktree, so no path leaves one waiting on an
 * entry that is gone.
 */
export async function finishQueuedLaunch(id: string, worktreeId: string): Promise<void> {
  const db = await getDb()
  await db.transaction(async (tx) => {
    const launched = await tx.update(queuedWorktrees)
      .set({ launchedWorktreeId: worktreeId })
      .where(claimedBy(id, worktreeId))
      .returning({ id: queuedWorktrees.id })
    if (launched.length === 0) return
    await tx.update(queuedWorktrees)
      .set({ parentWorktreeId: worktreeId, parentQueuedId: null })
      .where(and(eq(queuedWorktrees.parentQueuedId, id), pending))
  })
  notifyWorktreeListChanged()
}

/**
 * The launch under `worktreeId` failed: the entry goes back in the queue,
 * unreleased and carrying why, and every child of that worktree that has not
 * been released comes back under it — including one queued under it while
 * the launch was in flight. A child the worktree's own stop already released
 * keeps its pointer: a release is never taken back. A no-op unless the entry
 * is still claimed by that launch.
 */
export async function failQueuedLaunch(id: string, worktreeId: string, error: string): Promise<void> {
  const db = await getDb()
  await db.transaction(async (tx) => {
    const [row] = await tx.update(queuedWorktrees)
      .set({ launchWorktreeId: null, releasedAt: null, launchError: error })
      .where(claimedBy(id, worktreeId))
      .returning()
    if (!row) return
    await tx.update(queuedWorktrees)
      .set({ parentWorktreeId: null, parentQueuedId: id })
      .where(and(
        eq(queuedWorktrees.projectSlug, row.projectSlug),
        eq(queuedWorktrees.parentWorktreeId, worktreeId),
        isNull(queuedWorktrees.releasedAt),
        notLaunching,
      ))
  })
  notifyWorktreeListChanged()
}

/** Forget a project's entries, launched ones too — the project going away. */
export async function deleteProjectQueuedWorktrees(projectSlug: string): Promise<void> {
  const db = await getDb()
  await db.delete(queuedWorktrees).where(eq(queuedWorktrees.projectSlug, projectSlug))
}
