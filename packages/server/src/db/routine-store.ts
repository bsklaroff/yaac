import { and, asc, desc, eq, isNotNull, isNull, lt, or } from 'drizzle-orm'
import { getDb } from './client'
import { queuedWorkspaces, routines, workspaces } from './schema'
import { notifyWorkspaceListChanged } from '#lib/notify'
import { isUuid } from '#lib/uuid'
import { nullsToUndefined, type NullsToUndefined } from '#lib/nulls'
import type { AgentMode, AgentTool, PermissionMode, WorkspaceDeathReason } from '@yaac/shared/types'

/**
 * Routines: cron-scheduled workspaces (docs/routines.md). Nothing observes a
 * routine, so every write here notifies the snapshot hub itself.
 */

/** What a create stores and an update replaces. An absent effort, group or
 *  timeout is stored as null. */
export interface RoutineFields {
  name: string
  cron: string
  timeZone: string
  prompt: string
  tool: AgentTool
  model: string
  mode: AgentMode
  permissionMode: PermissionMode
  effort?: string
  branch: string
  groupId?: string
  timeoutMinutes?: number
  paused: boolean
  /** Null while paused. */
  nextRunAt: Date | null
}

type Row = typeof routines.$inferSelect

/** A routine (columns documented in schema.ts). */
export type RoutineRow = NullsToUndefined<Row>

const toRow = (r: Row): RoutineRow => nullsToUndefined(r)

function columns(f: RoutineFields): Omit<typeof routines.$inferInsert, 'projectId'> {
  return { ...f, effort: f.effort ?? null, groupId: f.groupId ?? null, timeoutMinutes: f.timeoutMinutes ?? null }
}

export async function insertRoutine(projectId: string, fields: RoutineFields): Promise<RoutineRow> {
  const db = await getDb()
  const [row] = await db.insert(routines).values({ projectId, ...columns(fields) }).returning()
  notifyWorkspaceListChanged()
  return toRow(row)
}

/** Replace a routine's fields. Returns undefined if it is gone. */
export async function updateRoutine(id: string, fields: RoutineFields): Promise<RoutineRow | undefined> {
  const db = await getDb()
  const rows = await db.update(routines).set(columns(fields)).where(eq(routines.id, id)).returning()
  notifyWorkspaceListChanged()
  return rows[0] ? toRow(rows[0]) : undefined
}

export async function getRoutineRow(id: string): Promise<RoutineRow | undefined> {
  if (!isUuid(id)) return undefined
  const db = await getDb()
  const rows = await db.select().from(routines).where(eq(routines.id, id))
  return rows[0] ? toRow(rows[0]) : undefined
}

/** Every routine of a project (or of all), oldest first. */
export async function listRoutineRows(projectId?: string): Promise<RoutineRow[]> {
  const db = await getDb()
  const rows = await db.select().from(routines)
    .where(projectId === undefined ? undefined : eq(routines.projectId, projectId))
    .orderBy(asc(routines.createdAt))
  return rows.map(toRow)
}

/**
 * Move a routine's next tick from `from` to `to`, recording `ranAt` as its
 * last run. A compare-and-set, so of two passes (or a pass and an edit)
 * racing on one tick only one fires it. Returns whether it moved.
 */
export async function advanceRoutine(id: string, from: Date, to: Date | null, ranAt: Date): Promise<boolean> {
  const db = await getDb()
  const rows = await db.update(routines)
    .set({ nextRunAt: to, lastRunAt: ranAt })
    .where(and(eq(routines.id, id), eq(routines.nextRunAt, from), eq(routines.paused, false)))
    .returning({ id: routines.id })
  if (rows.length > 0) notifyWorkspaceListChanged()
  return rows.length > 0
}

/** Delete a routine. Its entries keep running as plain queued entries
 *  (their `routineId` is cleared); the caller discards the pending ones
 *  first. */
export async function deleteRoutine(id: string): Promise<boolean> {
  const db = await getDb()
  const rows = await db.delete(routines).where(eq(routines.id, id)).returning({ id: routines.id })
  notifyWorkspaceListChanged()
  return rows.length > 0
}

export async function deleteProjectRoutines(projectId: string): Promise<void> {
  const db = await getDb()
  await db.delete(routines).where(eq(routines.projectId, projectId))
}

/** One run of a routine as its history lists it. */
export interface RoutineRunRow {
  /** The queued entry the run was. */
  id: string
  startAt?: Date
  title?: string
  /** Why its launch failed; set only while it has not launched. */
  launchError?: string
  /** The workspace it became, once launched, and that workspace's state. */
  workspaceId?: string
  stoppedAt?: Date
  deadline?: Date
  deathReason?: WorkspaceDeathReason
}

/**
 * A routine's runs, newest start first, `limit` at a time: every entry it
 * inserted, launched or not. `before` continues after the last run of the
 * previous page, as `<startAt ms>:<id>`.
 */
export async function listRoutineRuns(
  routineId: string,
  limit: number,
  before?: { startAt: Date; id: string },
): Promise<RoutineRunRow[]> {
  const db = await getDb()
  const rows = await db.select({
    id: queuedWorkspaces.id,
    startAt: queuedWorkspaces.startAt,
    title: queuedWorkspaces.title,
    launchError: queuedWorkspaces.launchError,
    workspaceId: workspaces.workspaceId,
    stoppedAt: workspaces.stoppedAt,
    deadline: workspaces.deadline,
    deathReason: workspaces.deathReason,
  })
    .from(queuedWorkspaces)
    .leftJoin(workspaces, eq(workspaces.workspaceId, queuedWorkspaces.launchedWorkspaceId))
    .where(and(
      eq(queuedWorkspaces.routineId, routineId),
      before === undefined ? undefined : or(
        lt(queuedWorkspaces.startAt, before.startAt),
        and(eq(queuedWorkspaces.startAt, before.startAt), lt(queuedWorkspaces.id, before.id)),
      ),
    ))
    .orderBy(desc(queuedWorkspaces.startAt), desc(queuedWorkspaces.id))
    .limit(limit)
  return rows.map((r) => nullsToUndefined(r))
}

/** The routine each launched workspace is a run of, by workspace id. */
export async function routineRunWorkspaces(): Promise<Map<string, string>> {
  const db = await getDb()
  const rows = await db.select({ workspaceId: queuedWorkspaces.launchedWorkspaceId, routineId: queuedWorkspaces.routineId })
    .from(queuedWorkspaces)
    .where(and(isNotNull(queuedWorkspaces.routineId), isNotNull(queuedWorkspaces.launchedWorkspaceId)))
  return new Map(rows.flatMap((r) => r.workspaceId !== null && r.routineId !== null ? [[r.workspaceId, r.routineId]] : []))
}

/** The newest run of each routine that has not launched, with its error:
 *  what the routine's failure mark shows. */
export async function listUnlaunchedRoutineRuns(): Promise<Array<{ id: string; routineId: string; launchError?: string }>> {
  const db = await getDb()
  const rows = await db.select({
    id: queuedWorkspaces.id,
    routineId: queuedWorkspaces.routineId,
    launchError: queuedWorkspaces.launchError,
  })
    .from(queuedWorkspaces)
    .where(isNull(queuedWorkspaces.launchedWorkspaceId))
    .orderBy(asc(queuedWorkspaces.createdAt))
  return rows.flatMap((r) => r.routineId === null ? [] : [{
    id: r.id,
    routineId: r.routineId,
    ...(r.launchError !== null ? { launchError: r.launchError } : {}),
  }])
}
