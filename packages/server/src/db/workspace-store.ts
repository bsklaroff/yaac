import { createHash } from 'node:crypto'
import { and, count, desc, eq, exists, ilike, inArray, isNotNull, isNull, lt, lte, notInArray, or, sql, type AnyColumn, type SQL } from 'drizzle-orm'
import { getDb } from './client'
import { conversations, sessions, workspaceConversations, workspaceGroups, workspaces } from './schema'
import { deleteWorkspaceConversations } from './conversation-store'
import { notifyWorkspaceListChanged } from '#lib/notify'
import { normalizeTitle } from '@yaac/shared/titles'
import { ServerError } from '@yaac/shared/errors'
import { nullsToUndefined, type NullsToUndefined } from '#lib/nulls'
import type { WorkspaceDeathCause } from '@yaac/shared/types'

/**
 * One row per workspace yaac has created. The runtime is authoritative for
 * whether a workspace is running; the agent-session store holds its
 * conversations.
 *
 * Write rules:
 *  - `recordWorkspaceCreated` is the only INSERT and never upserts: an id is
 *    claimed once across all projects. A restart is
 *    `recordWorkspaceResumed`, an UPDATE.
 *  - Everything else is an UPDATE, which no-ops for a missing row, so
 *    workspaces from a foreign data dir stay invisible without checks.
 *  - The row is written before the runtime starts, so every user workspace
 *    has one. A prewarmed spare has none until a claim inserts it
 *    (docs/workspace-storage.md).
 *  - A stop never deletes a row: rows with `stoppedAt` are the stopped
 *    listing, and a restart clears it. Rows are deleted only when the project
 *    is removed (`deleteProjectWorkspaces`), or one workspace is deleted or
 *    its create rolls back (`deleteWorkspaceRecords`).
 *
 * Every read and write propagates errors; a caller that must carry on (a
 * teardown) catches them itself.
 */

/** Fields `recordWorkspaceCreated` stamps on a fresh workspace. */
export interface WorkspaceCreatedInput {
  projectId: string
  workspaceId: string
  /** Branch the workspace forked from. */
  baseBranch?: string
  /** The user's title. */
  title?: string
  /** A title generated for the draft or queued entry it came from. */
  generatedTitle?: string
  /** The sidebar group; left ungrouped if the group no longer exists. */
  groupId?: string
  /** The zone it launches with as `TZ`. */
  timeZone?: string
  /** When the server stops it. */
  deadline?: Date
  /** The scratch dirs it is started with (see `workspaces.scratchDirs`). */
  scratchDirs?: string[]
}

type Row = typeof workspaces.$inferSelect

/** A workspace row as the display paths consume it (columns documented in
 *  schema.ts). */
export type WorkspaceRow = NullsToUndefined<Omit<Row, 'mamaTokenHash'>>

function toRow({ mamaTokenHash: _, ...r }: Row): WorkspaceRow {
  return nullsToUndefined(r)
}

const key = (projectId: string, workspaceId: string) =>
  and(eq(workspaces.projectId, projectId), eq(workspaces.workspaceId, workspaceId))

/**
 * Record a workspace as created: a plain INSERT, since an id is claimed once.
 * An id already taken in any project is a `CONFLICT` that leaves the existing
 * row alone (an upsert would let the failing create tear down the existing
 * workspace as its own).
 *
 * Throws on failure; callers must treat that as a failed create.
 */
export async function recordWorkspaceCreated(input: WorkspaceCreatedInput): Promise<void> {
  const db = await getDb()
  const title = input.title === undefined ? '' : normalizeTitle(input.title)
  const rows = await db.insert(workspaces)
    .values({
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch } : {}),
      ...(title !== '' ? { title } : {}),
      ...(input.generatedTitle !== undefined ? { generatedTitle: input.generatedTitle } : {}),
      // A subquery, so a group deleted since the request was resolved
      // leaves the workspace ungrouped rather than filed under nothing.
      ...(input.groupId !== undefined
        ? {
          groupId: sql`(${db.select({ groupId: workspaceGroups.groupId }).from(workspaceGroups)
            .where(and(
              eq(workspaceGroups.projectId, input.projectId),
              eq(workspaceGroups.groupId, input.groupId),
            ))})`,
        }
        : {}),
      ...(input.timeZone !== undefined ? { timeZone: input.timeZone } : {}),
      ...(input.deadline !== undefined ? timeoutColumns(input.deadline) : {}),
      ...(input.scratchDirs !== undefined ? { scratchDirs: input.scratchDirs } : {}),
    })
    .onConflictDoNothing({ target: workspaces.workspaceId })
    .returning({ workspaceId: workspaces.workspaceId })
  if (!rows[0]) {
    throw new ServerError('CONFLICT', `workspace id ${input.workspaceId} is already in use`)
  }
}

/**
 * Record a stopped workspace as restarting: update the launch fields.
 * `createdAt`, title and group are kept, so the workspace returns to its
 * group. The stop stays until the restart succeeds (`clearWorkspaceStopped`),
 * so a failed restart leaves the row as it found it.
 *
 * Never inserts. Stopped workspaces keep their rows, so a missing row (for
 * example after a DB reset) is `NOT_FOUND`.
 */
export async function recordWorkspaceResumed(
  input: Pick<
    WorkspaceCreatedInput,
    'projectId' | 'workspaceId' | 'timeZone' | 'deadline' | 'scratchDirs'
  >,
): Promise<void> {
  const db = await getDb()
  const rows = await db.update(workspaces).set({
    ...(input.scratchDirs !== undefined ? { scratchDirs: input.scratchDirs } : {}),
    // A resume launches a new process, in the zone the create read now.
    timeZone: input.timeZone ?? null,
    // A restart stops only at a timeout the restart itself set.
    ...timeoutColumns(input.deadline ?? null),
  }).where(key(input.projectId, input.workspaceId))
    .returning({ workspaceId: workspaces.workspaceId })
  if (!rows[0]) {
    throw new ServerError('NOT_FOUND', `workspace ${input.workspaceId} has no record to resume`)
  }
}

/** Record that a new runtime (a "life") has come up, so none of the
 *  workspace's sessions has a window in it yet. */
export async function recordWorkspaceLife(
  projectId: string,
  workspaceId: string,
): Promise<void> {
  const db = await getDb()
  await db.update(workspaces)
    .set({ lifeStartedAt: new Date() })
    .where(key(projectId, workspaceId))
}

/**
 * Stamp the stop time, plus the cause when a reaper (not the user) stopped
 * it. Only a live row is written: the first stop recorded in a life stands.
 * A stale-reaper pass that probed the workspace while a user stop was
 * killing it would otherwise relabel that stop as a death, and a resumed
 * teardown would wipe the cause it is resuming. A stop recorded before the
 * current life began is overwritten: a restart whose clear of it was lost
 * would otherwise keep the old date, which retention ages the workspace by.
 *
 * Leaves its sessions open and `workspace_conversations.active` alone: they
 * are what a restart brings back.
 */
export async function recordWorkspaceStopped(
  projectId: string,
  workspaceId: string,
  cause?: WorkspaceDeathCause,
): Promise<void> {
  const db = await getDb()
  await db.update(workspaces).set({
    stoppedAt: new Date(),
    deathReason: cause?.reason ?? null,
    deathDetail: cause?.detail ?? null,
    deathSeenBy: [],
  }).where(and(key(projectId, workspaceId),
    or(isNull(workspaces.stoppedAt), lt(workspaces.stoppedAt, workspaces.lifeStartedAt))))
}

/** Stamp a stopped workspace's ignored files as removed by a clean that
 *  began at `at`, unless its stop came later. */
export async function recordIgnoredFilesCleaned(projectId: string, workspaceId: string, at: Date): Promise<void> {
  const db = await getDb()
  await db.update(workspaces).set({ ignoredCleanedAt: at })
    .where(and(key(projectId, workspaceId), lte(workspaces.stoppedAt, at)))
}

/** Stopped workspaces whose ignored files no clean has removed since the
 *  stop, oldest stop first. */
export async function listUncleanedStoppedWorkspaces(): Promise<Array<{ projectId: string; workspaceId: string }>> {
  const db = await getDb()
  return await db.select({ projectId: workspaces.projectId, workspaceId: workspaces.workspaceId })
    .from(workspaces)
    .where(and(isNotNull(workspaces.stoppedAt),
      or(isNull(workspaces.ignoredCleanedAt), lt(workspaces.ignoredCleanedAt, workspaces.stoppedAt))))
    .orderBy(workspaces.stoppedAt)
}

/** Clear a workspace's stop (its id is live again after a restart). */
export async function clearWorkspaceStopped(
  projectId: string,
  workspaceId: string,
): Promise<void> {
  const db = await getDb()
  await db.update(workspaces).set({
    stoppedAt: null,
    deathReason: null,
    deathDetail: null,
    deathSeenBy: [],
  }).where(key(projectId, workspaceId))
}

/** Mark an abnormal death as seen by `userId` (they opened its detail).
 *  Notifies, since the snapshot counts who has seen each death. */
export async function recordDeathSeen(projectId: string, workspaceId: string, userId: string): Promise<void> {
  const db = await getDb()
  await db.update(workspaces).set({ deathSeenBy: appendUser(workspaces.deathSeenBy, userId) })
    .where(and(key(projectId, workspaceId), lacksUser(workspaces.deathSeenBy, userId)))
  notifyWorkspaceListChanged()
}

/**
 * Mark every recorded abnormal death in a project as seen by `userId`
 * ("mark all as read"). Only rows that actually died are touched.
 * Notifies, like `recordDeathSeen`.
 */
export async function recordAllDeathsSeen(projectId: string, userId: string): Promise<void> {
  const db = await getDb()
  await db.update(workspaces).set({ deathSeenBy: appendUser(workspaces.deathSeenBy, userId) }).where(and(
    eq(workspaces.projectId, projectId),
    isNotNull(workspaces.deathReason),
    lacksUser(workspaces.deathSeenBy, userId),
  ))
  notifyWorkspaceListChanged()
}

/** A seen-by list with `userId` added, and the check that it is not in one
 *  yet, so a repeated mark leaves the row alone. */
export function appendUser(list: AnyColumn, userId: string): SQL {
  return sql`array_append(${list}, ${userId}::uuid)`
}
export function lacksUser(list: AnyColumn, userId: string): SQL {
  return sql`not (${userId}::uuid = any(${list}))`
}

/**
 * Store the SHA-256 of the bearer token this workspace's `yaac-mama` will
 * present. Written at launch for runtimes whose workspaces reach the server
 * directly (containerless). No notification, since nothing rendered changes.
 */
export async function setWorkspaceMamaTokenHash(
  projectId: string,
  workspaceId: string,
  hash: string,
): Promise<void> {
  const db = await getDb()
  await db.update(workspaces).set({ mamaTokenHash: hash }).where(key(projectId, workspaceId))
}

/**
 * Which workspace owns this `yaac-mama` token, if any. Under containerless
 * this identifies the caller, as the proxy's source-IP lookup does under k8s.
 * Hashes the token here so callers never handle the stored form. A stopped
 * workspace still matches; commands are project-scoped either way.
 */
export async function findWorkspaceByMamaToken(token: string): Promise<WorkspaceRow | undefined> {
  if (token === '') return undefined
  const hash = createHash('sha256').update(token).digest('hex')
  const db = await getDb()
  const rows = await db.select().from(workspaces).where(eq(workspaces.mamaTokenHash, hash))
  return rows[0] ? toRow(rows[0]) : undefined
}

/**
 * Set (or, with a blank title, clear) a workspace's user title. A cleared
 * workspace shows its agent's own title, or its generated one, again.
 */
export async function setWorkspaceTitle(projectId: string, workspaceId: string, title: string): Promise<void> {
  const normalized = normalizeTitle(title)
  const db = await getDb()
  await db.update(workspaces)
    .set({ title: normalized === '' ? null : normalized })
    .where(key(projectId, workspaceId))
  notifyWorkspaceListChanged()
}

/** Set (or, with null, clear) when the server stops a workspace. A no-op
 *  for a stopped one, whose next deadline only a restart sets. Returns
 *  whether a running workspace's row changed. */
export async function setWorkspaceDeadline(projectId: string, workspaceId: string, deadline: Date | null): Promise<boolean> {
  const db = await getDb()
  const rows = await db.update(workspaces)
    .set(timeoutColumns(deadline))
    .where(and(key(projectId, workspaceId), isNull(workspaces.stoppedAt)))
    .returning({ workspaceId: workspaces.workspaceId })
  if (rows.length > 0) notifyWorkspaceListChanged()
  return rows.length > 0
}

/** A deadline and the length of the timeout that set it, counted from now
 *  (whole minutes, at least one). */
function timeoutColumns(deadline: Date | null): { deadline: Date | null; timeoutMinutes: number | null; deadlineIsNextRun: false } {
  return {
    deadline,
    deadlineIsNextRun: false,
    timeoutMinutes: deadline === null ? null : Math.max(1, Math.round((deadline.getTime() - Date.now()) / 60_000)),
  }
}

/** Mark a routine run's deadline as its routine's next tick
 *  (`workspaces.deadlineIsNextRun`). A later deadline write clears it. */
export async function markDeadlineIsNextRun(projectId: string, workspaceId: string): Promise<void> {
  const db = await getDb()
  await db.update(workspaces).set({ deadlineIsNextRun: true }).where(key(projectId, workspaceId))
}

/** Rows not recorded as stopped whose deadline is at or before `now`. */
export async function listOverdueWorkspaceRows(now: Date): Promise<WorkspaceRow[]> {
  const db = await getDb()
  const rows = await db.select().from(workspaces)
    .where(and(isNull(workspaces.stoppedAt), lte(workspaces.deadline, now)))
  return rows.map(toRow)
}

/** Record a generated title, only if the workspace has none yet, checked in
 *  the same statement so a concurrent write is never replaced. */
export async function setWorkspaceGeneratedTitle(projectId: string, workspaceId: string, title: string): Promise<void> {
  const db = await getDb()
  const rows = await db.update(workspaces)
    .set({ generatedTitle: title })
    .where(and(key(projectId, workspaceId), isNull(workspaces.generatedTitle)))
    .returning({ workspaceId: workspaces.workspaceId })
  if (rows.length > 0) notifyWorkspaceListChanged()
}

/** Every row of a project, keyed by workspace id, in one query. */
export async function getProjectWorkspaceRows(
  projectId: string,
): Promise<Map<string, WorkspaceRow>> {
  const db = await getDb()
  const rows = await db.select().from(workspaces)
    .where(eq(workspaces.projectId, projectId))
  return new Map(rows.map((r) => [r.workspaceId, toRow(r)]))
}

/** Rows across every project (or one), for the stopped-workspace listing. */
export async function listWorkspaceRows(projectId?: string): Promise<WorkspaceRow[]> {
  const db = await getDb()
  const rows = projectId === undefined
    ? await db.select().from(workspaces)
    : await db.select().from(workspaces).where(eq(workspaces.projectId, projectId))
  return rows.map(toRow)
}

/** What `listStoppedWorkspaceRows` narrows the stopped rows to. */
export interface StoppedRowFilter {
  /** Only these projects' rows; an empty list matches none. */
  projectIds?: string[]
  /** Ids to leave out: the ones the runtime reports running, since a
   *  restart keeps its stop until it succeeds. */
  excludeIds?: string[]
  /** Matched case-insensitively against the user and generated titles, and
   *  the first prompt, agent title and tool of each of the workspace's
   *  conversations. */
  q?: string
  groupId?: string
  /** Leave out the members of these groups. */
  excludeGroupIds?: string[]
  workspaceId?: string
}

/** Where a page of stopped rows starts: just after this row. */
export interface StoppedRowCursor {
  stoppedAt: Date
  workspaceId: string
}

/**
 * Rows with a recorded stop, newest stop first (the id breaks ties), one
 * page at a time, plus how many match in all. Paging is by keyset, so a stop
 * landing between two pages neither repeats nor skips a row. `limit`
 * undefined returns every row after the cursor.
 *
 * Both the order and the keyset use the stop time cut to milliseconds, the
 * precision a cursor carries: older installs hold stops written by the
 * database with microseconds, and comparing those against a cursor that
 * dropped them would skip rows.
 */
export async function listStoppedWorkspaceRows(
  filter: StoppedRowFilter,
  page: { limit?: number; after?: StoppedRowCursor } = {},
): Promise<{ rows: WorkspaceRow[]; total: number }> {
  const db = await getDb()
  const conds: (SQL | undefined)[] = [isNotNull(workspaces.stoppedAt)]
  if (filter.projectIds !== undefined) {
    conds.push(filter.projectIds.length > 0 ? inArray(workspaces.projectId, filter.projectIds) : sql`false`)
  }
  if (filter.workspaceId !== undefined) conds.push(eq(workspaces.workspaceId, filter.workspaceId))
  if (filter.groupId !== undefined) conds.push(eq(workspaces.groupId, filter.groupId))
  if (filter.excludeIds?.length) conds.push(notInArray(workspaces.workspaceId, filter.excludeIds))
  if (filter.excludeGroupIds?.length) {
    conds.push(or(isNull(workspaces.groupId), notInArray(workspaces.groupId, filter.excludeGroupIds)))
  }
  const q = filter.q?.trim()
  if (q) {
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    conds.push(or(
      ilike(workspaces.title, pattern),
      ilike(workspaces.generatedTitle, pattern),
      exists(db.select({ one: sql`1` }).from(workspaceConversations)
        .innerJoin(conversations, and(
          eq(workspaceConversations.projectId, conversations.projectId),
          eq(workspaceConversations.tool, conversations.tool),
          eq(workspaceConversations.conversationId, conversations.conversationId),
        ))
        .where(and(
          eq(workspaceConversations.projectId, workspaces.projectId),
          eq(workspaceConversations.workspaceId, workspaces.workspaceId),
          or(
            ilike(conversations.firstPrompt, pattern),
            ilike(conversations.title, pattern),
            ilike(conversations.tool, pattern),
          ),
        ))),
    ))
  }
  const where = and(...conds)
  const after = page.after
  const stoppedMs = sql`date_trunc('milliseconds', ${workspaces.stoppedAt})`
  const afterMs = after && sql`${after.stoppedAt.toISOString()}::timestamptz`
  const rows = await db.select().from(workspaces)
    .where(after === undefined ? where : and(where, or(
      sql`${stoppedMs} < ${afterMs}`,
      and(sql`${stoppedMs} = ${afterMs}`, lt(workspaces.workspaceId, after.workspaceId)),
    )))
    .orderBy(desc(stoppedMs), desc(workspaces.workspaceId))
    .limit(page.limit ?? Number.MAX_SAFE_INTEGER)
  const [counted] = await db.select({ n: count() }).from(workspaces).where(where)
  return { rows: rows.map(toRow), total: counted?.n ?? 0 }
}

/** Stopped workspaces counted per project and group, for the snapshot. */
export interface StoppedCount {
  projectId: string
  /** Null for ungrouped workspaces. */
  groupId: string | null
  /** Stops, less those in `excludeIds`. */
  stopped: number
  /** Deaths among every stop, and how many of them each user has viewed. */
  deaths: number
  deathsSeenBy: Record<string, number>
}

/** `excludeIds` are the stopped workspaces the snapshot draws a row of their
 *  own for (still stopping, held, or restarting), so each is counted once. */
export async function countStoppedWorkspaces(excludeIds: string[] = []): Promise<StoppedCount[]> {
  const db = await getDb()
  const counted = excludeIds.length > 0 ? notInArray(workspaces.workspaceId, excludeIds) : sql`true`
  const died = sql`${workspaces.deathReason} is not null`
  const rows = await db.select({
    projectId: workspaces.projectId,
    groupId: workspaces.groupId,
    stopped: sql<number>`count(*) filter (where ${counted})`.mapWith(Number),
    deaths: sql<number>`count(*) filter (where ${died})`.mapWith(Number),
    seenBy: sql<string[][] | null>`jsonb_agg(${workspaces.deathSeenBy})
      filter (where ${died} and cardinality(${workspaces.deathSeenBy}) > 0)`,
  }).from(workspaces)
    .where(isNotNull(workspaces.stoppedAt))
    .groupBy(workspaces.projectId, workspaces.groupId)
  return rows.map(({ seenBy, ...r }) => {
    const deathsSeenBy: Record<string, number> = {}
    for (const userId of (seenBy ?? []).flat()) deathsSeenBy[userId] = (deathsSeenBy[userId] ?? 0) + 1
    return { ...r, deathsSeenBy }
  })
}

/**
 * A workspace's row by exact id, in whichever project holds it (ids are
 * unique across projects). Prefix matching is done by `resolveWorkspace` in
 * domain.
 */
export async function findWorkspaceRow(workspaceId: string): Promise<WorkspaceRow | undefined> {
  if (workspaceId === '') return undefined
  const db = await getDb()
  const rows = await db.select().from(workspaces)
    .where(eq(workspaces.workspaceId, workspaceId))
  return rows[0] ? toRow(rows[0]) : undefined
}

/** One workspace's row, or undefined. */
export async function getWorkspaceRow(
  projectId: string,
  workspaceId: string,
): Promise<WorkspaceRow | undefined> {
  const db = await getDb()
  const rows = await db.select().from(workspaces).where(key(projectId, workspaceId))
  return rows[0] ? toRow(rows[0]) : undefined
}

/**
 * Delete a workspace's row and its conversation links, plus any conversation
 * no other workspace links. For a deleted workspace.
 */
export async function deleteWorkspaceRecords(
  projectId: string,
  workspaceId: string,
): Promise<void> {
  await removeWorkspaceRecords(projectId, workspaceId)
  notifyWorkspaceListChanged()
}

/**
 * `deleteWorkspaceRecords` without the push, for a create that never came up,
 * whose event already pushes. The row goes first, since it is what makes the
 * workspace visible.
 */
export async function removeWorkspaceRecords(
  projectId: string,
  workspaceId: string,
): Promise<void> {
  const db = await getDb()
  await db.delete(workspaces).where(key(projectId, workspaceId))
  await deleteWorkspaceConversations(projectId, workspaceId)
}

/** Record the branch the workspace is based on, for a `yaac-mama set-base`. */
export async function setWorkspaceBaseBranch(
  projectId: string,
  workspaceId: string,
  baseBranch: string,
): Promise<void> {
  const db = await getDb()
  await db.update(workspaces).set({ baseBranch }).where(key(projectId, workspaceId))
}

/** Take `paths` off the scratch dirs a workspace was started with, so its
 *  stop leaves them in its checkout. A row recording none is left as is. */
export async function forgetWorkspaceScratchDirs(projectId: string, workspaceId: string, paths: string[]): Promise<void> {
  const db = await getDb()
  const [row] = await db.select({ scratchDirs: workspaces.scratchDirs }).from(workspaces).where(key(projectId, workspaceId))
  if (!row?.scratchDirs) return
  await db.update(workspaces).set({ scratchDirs: row.scratchDirs.filter((d) => !paths.includes(d)) })
    .where(key(projectId, workspaceId))
}

/** Record `scratchDirs` for each of the project's workspaces that has none
 *  recorded, all of which predate the column (docs/legacy-compat-shims.md). */
export async function backfillWorkspaceScratchDirs(projectId: string, scratchDirs: string[]): Promise<void> {
  const db = await getDb()
  await db.update(workspaces).set({ scratchDirs })
    .where(and(eq(workspaces.projectId, projectId), isNull(workspaces.scratchDirs)))
}

export async function setWorkspaceTrackedScratchDirs(
  projectId: string,
  workspaceId: string,
  trackedScratchDirs: string[],
): Promise<void> {
  const db = await getDb()
  await db.update(workspaces).set({ trackedScratchDirs }).where(key(projectId, workspaceId))
}

/**
 * Workspaces with no recorded stop, which the reaper checks for a missing
 * runtime. `ran` is true if the agent ever started (a captured opening
 * message or transcript exists), separating an interrupted create from a
 * workspace whose runtime was removed out-of-band.
 */
export async function listLiveWorkspaceRows(): Promise<Array<{
  projectId: string
  workspaceId: string
  ran: boolean
}>> {
  const db = await getDb()
  const rows = await db.select({
    projectId: workspaces.projectId,
    workspaceId: workspaces.workspaceId,
  }).from(workspaces).where(isNull(workspaces.stoppedAt))
  // A conversation proves its agent started, since only a live agent
  // names one, and a launched session proves the create got that far.
  const conversed = await db.selectDistinct({
    projectId: workspaceConversations.projectId,
    workspaceId: workspaceConversations.workspaceId,
  }).from(workspaceConversations)
  const launched = await db.selectDistinct({ projectId: sessions.projectId, workspaceId: sessions.workspaceId })
    .from(sessions).where(isNotNull(sessions.launchedAt))
  const ran = new Set([...conversed, ...launched].map((l) => `${l.projectId}/${l.workspaceId}`))
  return rows.map((r) => ({
    projectId: r.projectId,
    workspaceId: r.workspaceId,
    ran: ran.has(`${r.projectId}/${r.workspaceId}`),
  }))
}

/** Every workspace id of a project. */
export async function listProjectWorkspaceIds(projectId: string): Promise<string[]> {
  const db = await getDb()
  const rows = await db.select({ workspaceId: workspaces.workspaceId })
    .from(workspaces)
    .where(eq(workspaces.projectId, projectId))
  return rows.map((r) => r.workspaceId)
}

/**
 * Delete a project's workspace rows, on project removal (which also deletes
 * the checkouts). The caller also runs `deleteProjectConversations`.
 */
export async function deleteProjectWorkspaces(projectId: string): Promise<void> {
  const db = await getDb()
  await db.delete(workspaces).where(eq(workspaces.projectId, projectId))
}
