import { createHash } from 'node:crypto'
import { and, count, desc, eq, exists, getTableColumns, gt, ilike, inArray, isNotNull, isNull, lt, lte, notInArray, or, sql, type AnyColumn, type SQL } from 'drizzle-orm'
import { getDb } from './client'
import { conversations, sessions, workspaceConversations, workspaceGroups, workspaceLives, workspaceRepos, workspaces } from './schema'
import { deleteWorkspaceConversations } from './conversation-store'
import { currentLife, isCurrentLife } from './current-life'
import type { WorkspaceRepoRow } from './repo-store'
import { notifyWorkspaceListChanged } from '#lib/notify'
import { normalizeTitle } from '@yaac/shared/titles'
import { ServerError } from '@yaac/shared/errors'
import { nullsToUndefined, type NullsToUndefined } from '#lib/nulls'
import type { WorkspaceDeathCause } from '@yaac/shared/types'
import type { StepsOutcome } from '@yaac/shared/steps'

/**
 * One row per workspace yaac has created, and one per life of it. The
 * runtime is authoritative for whether a workspace is running; the
 * conversation store holds its conversations, and the session store its
 * agents.
 *
 * Write rules:
 *  - `recordWorkspaceCreated` is the only INSERT of a workspace and never
 *    upserts: an id is claimed once across all projects. It inserts the
 *    first life with the row, so every workspace has one; a restart adds the
 *    next (`recordWorkspaceLife`).
 *  - What a life launched with and how it ended is written to the current
 *    life, the workspace's newest. An earlier life is never written again.
 *  - Everything else is an UPDATE, which no-ops for a missing row, so
 *    workspaces from a foreign data dir stay invisible without checks.
 *  - The row is written before the runtime starts, so every user workspace
 *    has one. A prewarmed spare has none until a claim inserts it
 *    (docs/workspace-storage.md).
 *  - A stop never deletes a row: the workspaces whose current life has a
 *    stop are the stopped listing. Rows are deleted only when the project
 *    is removed (`deleteProjectWorkspaces`), or one workspace is deleted or
 *    its create rolls back (`deleteWorkspaceRecords`).
 *
 * Every read and write propagates errors; a caller that must carry on (a
 * teardown) catches them itself.
 */

/** What a life launches with. */
export interface LifeLaunch {
  /** When it starts, which names its log dir and its steps' life. */
  at: Date
  /** The zone it launches with as `TZ`. */
  timeZone?: string
  /** When the server stops it. */
  deadline?: Date
  /** The scratch dirs it is started with (see `workspaceLives.scratchDirs`). */
  scratchDirs?: string[]
}

/** Fields `recordWorkspaceCreated` stamps on a fresh workspace and its
 *  first life, which starts now unless `at` says when. */
export interface WorkspaceCreatedInput extends Partial<LifeLaunch> {
  projectId: string
  workspaceId: string
  /** Its checkouts, each with the branch it forks from if known yet. */
  repos?: Array<Omit<WorkspaceRepoRow, 'workspaceId'>>
  /** Where its shells and steps start. */
  cwd?: string
  /** The user's title. */
  title?: string
  /** A title generated for the draft or queued entry it came from. */
  generatedTitle?: string
  /** The sidebar group; left ungrouped if the group no longer exists. */
  groupId?: string
  /** The workflow it brought in place of the project's init workflows. */
  workflowId?: string
  /** The name that workflow has in it, which its steps are known by. */
  workflowName?: string
  nonInteractive?: boolean
  /** The workspace it reruns: a non-interactive one, or a site's release
   *  that died. */
  rerunOf?: string
  /** The public site it is a release of. */
  siteId?: string
}

/** The current lives of a project's workspaces, or of one of them, for a
 *  write to them. */
const currentLifeOf = (projectId: string, workspaceId?: string): SQL | undefined => and(
  workspaceId !== undefined ? eq(workspaceLives.workspaceId, workspaceId) : undefined,
  isCurrentLife,
  sql`${workspaceLives.workspaceId} in (select workspace_id from workspaces where project_id = ${projectId})`,
)

const { workspaceId: _lifeWorkspaceId, startedAt: lifeStartedAt, ...lifeColumns } = getTableColumns(workspaceLives)
const rowColumns = { ...getTableColumns(workspaces), ...lifeColumns, lifeStartedAt }

type Row = typeof workspaces.$inferSelect
  & Omit<typeof workspaceLives.$inferSelect, 'workspaceId' | 'startedAt'>
  & { lifeStartedAt: Date }

/**
 * A workspace with its current life, as the display paths consume it
 * (columns documented in schema.ts): `lifeStartedAt` is when that life
 * began, and the stop, deadline and launch fields are that life's.
 */
export type WorkspaceRow = NullsToUndefined<Omit<Row, 'mamaTokenHash'>>

function toRow({ mamaTokenHash: _, ...r }: Row): WorkspaceRow {
  return nullsToUndefined(r)
}

/** Every workspace with its current life, for a read to narrow. Not
 *  async: awaiting the query would run it. */
function selectRows(db: Awaited<ReturnType<typeof getDb>>) {
  return db.select(rowColumns).from(workspaces).innerJoin(workspaceLives, currentLife)
}

const key = (projectId: string, workspaceId: string) =>
  and(eq(workspaces.projectId, projectId), eq(workspaces.workspaceId, workspaceId))

/** A life's row, as it starts. */
function lifeValues(workspaceId: string, launch: LifeLaunch): typeof workspaceLives.$inferInsert {
  return {
    workspaceId,
    startedAt: launch.at,
    ...(launch.timeZone !== undefined ? { timeZone: launch.timeZone } : {}),
    ...(launch.scratchDirs !== undefined ? { scratchDirs: launch.scratchDirs } : {}),
    ...(launch.deadline !== undefined ? timeoutColumns(launch.deadline) : {}),
  }
}

/**
 * Record a workspace as created, with its checkouts and its first life: a
 * plain INSERT, since an id is claimed once. An id already taken in any
 * project is a `CONFLICT` that leaves the existing row alone (an upsert
 * would let the failing create tear down the existing workspace as its own).
 *
 * Throws on failure; callers must treat that as a failed create.
 */
export async function recordWorkspaceCreated(input: WorkspaceCreatedInput): Promise<void> {
  const db = await getDb()
  const title = input.title === undefined ? '' : normalizeTitle(input.title)
  await db.transaction(async (tx) => {
    const rows = await tx.insert(workspaces)
      .values({
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
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
        ...(input.workflowId !== undefined ? { workflowId: input.workflowId } : {}),
        ...(input.workflowName !== undefined ? { workflowName: input.workflowName } : {}),
        ...(input.nonInteractive === true ? { nonInteractive: true } : {}),
        ...(input.rerunOf !== undefined ? { rerunOf: input.rerunOf } : {}),
        ...(input.siteId !== undefined ? { siteId: input.siteId } : {}),
      })
      .onConflictDoNothing({ target: workspaces.workspaceId })
      .returning({ workspaceId: workspaces.workspaceId })
    if (!rows[0]) {
      throw new ServerError('CONFLICT', `workspace id ${input.workspaceId} is already in use`)
    }
    if (input.repos?.length) {
      await tx.insert(workspaceRepos).values(input.repos.map((r) => ({ ...r, workspaceId: input.workspaceId })))
    }
    await tx.insert(workspaceLives).values(lifeValues(input.workspaceId, { ...input, at: input.at ?? new Date() }))
  })
}

/**
 * Record a restart: the workspace's next life, with what it launches with.
 * The workspace row, its title and group are kept, and so is every earlier
 * life, with the stop it recorded.
 *
 * Stopped workspaces keep their rows, so a missing row (for example after a
 * DB reset) is `NOT_FOUND`.
 */
export async function recordWorkspaceLife(projectId: string, workspaceId: string, launch: LifeLaunch): Promise<void> {
  const db = await getDb()
  const [row] = await db.select({ workspaceId: workspaces.workspaceId }).from(workspaces).where(key(projectId, workspaceId))
  if (!row) {
    throw new ServerError('NOT_FOUND', `workspace ${workspaceId} has no record to resume`)
  }
  await db.insert(workspaceLives).values(lifeValues(workspaceId, launch))
}

/** Stamp the current life as up, once. */
export async function recordWorkspaceLaunched(projectId: string, workspaceId: string): Promise<void> {
  const db = await getDb()
  await db.update(workspaceLives).set({ launchedAt: new Date() })
    .where(and(currentLifeOf(projectId, workspaceId), isNull(workspaceLives.launchedAt)))
}

/** Forget the life started after the one that began at `after`, by a
 *  restart that never came up, so the workspace reads as that restart found
 *  it. */
export async function removeWorkspaceLivesAfter(workspaceId: string, after: Date): Promise<void> {
  const db = await getDb()
  await db.delete(workspaceLives)
    .where(and(eq(workspaceLives.workspaceId, workspaceId), gt(workspaceLives.startedAt, after)))
}

/** Record how a non-interactive workspace's graph ended; the first one
 *  recorded stands. */
export async function setWorkspaceStepsOutcome(projectId: string, workspaceId: string, outcome: StepsOutcome): Promise<void> {
  const db = await getDb()
  await db.update(workspaceLives).set({ stepsOutcome: outcome })
    .where(and(currentLifeOf(projectId, workspaceId), isNull(workspaceLives.stepsOutcome)))
}

/**
 * Stamp the stop time on the current life, plus the cause when a reaper (not
 * the user) stopped it. Only a life with no stop is written: the first stop
 * recorded in a life stands. A stale-reaper pass that probed the workspace
 * while a user stop was killing it would otherwise relabel that stop as a
 * death, and a resumed teardown would wipe the cause it is resuming.
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
  await db.update(workspaceLives).set({
    stoppedAt: new Date(),
    deathReason: cause?.reason ?? null,
    deathDetail: cause?.detail ?? null,
  }).where(and(currentLifeOf(projectId, workspaceId), isNull(workspaceLives.stoppedAt)))
}

/** Stamp a stopped workspace's ignored files as removed by a clean that
 *  began at `at`, unless its stop came later. */
export async function recordIgnoredFilesCleaned(projectId: string, workspaceId: string, at: Date): Promise<void> {
  const db = await getDb()
  await db.update(workspaceLives).set({ ignoredCleanedAt: at })
    .where(and(currentLifeOf(projectId, workspaceId), lte(workspaceLives.stoppedAt, at)))
}

/** Stopped workspaces whose ignored files no clean has removed since the
 *  stop, oldest stop first. */
export async function listUncleanedStoppedWorkspaces(): Promise<Array<{ projectId: string; workspaceId: string }>> {
  const db = await getDb()
  return await db.select({ projectId: workspaces.projectId, workspaceId: workspaces.workspaceId })
    .from(workspaces).innerJoin(workspaceLives, currentLife)
    .where(and(isNotNull(workspaceLives.stoppedAt), isNull(workspaceLives.ignoredCleanedAt)))
    .orderBy(workspaceLives.stoppedAt)
}

/** Mark an abnormal death as seen by `userId` (they opened its detail).
 *  Notifies, since the snapshot counts who has seen each death. */
export async function recordDeathSeen(projectId: string, workspaceId: string, userId: string): Promise<void> {
  const db = await getDb()
  await db.update(workspaceLives).set({ deathSeenBy: appendUser(workspaceLives.deathSeenBy, userId) })
    .where(and(currentLifeOf(projectId, workspaceId), lacksUser(workspaceLives.deathSeenBy, userId)))
  notifyWorkspaceListChanged()
}

/**
 * Mark every recorded abnormal death in a project as seen by `userId`
 * ("mark all as read"). Only current lives that died are touched.
 * Notifies, like `recordDeathSeen`.
 */
export async function recordAllDeathsSeen(projectId: string, userId: string): Promise<void> {
  const db = await getDb()
  await db.update(workspaceLives).set({ deathSeenBy: appendUser(workspaceLives.deathSeenBy, userId) }).where(and(
    currentLifeOf(projectId),
    isNotNull(workspaceLives.deathReason),
    lacksUser(workspaceLives.deathSeenBy, userId),
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
  const rows = await selectRows(await getDb()).where(eq(workspaces.mamaTokenHash, hash))
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
 *  whether a running workspace's life changed. */
export async function setWorkspaceDeadline(projectId: string, workspaceId: string, deadline: Date | null): Promise<boolean> {
  const db = await getDb()
  const rows = await db.update(workspaceLives)
    .set(timeoutColumns(deadline))
    .where(and(currentLifeOf(projectId, workspaceId), isNull(workspaceLives.stoppedAt)))
    .returning({ workspaceId: workspaceLives.workspaceId })
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
 *  (`workspaceLives.deadlineIsNextRun`). A later deadline write clears it. */
export async function markDeadlineIsNextRun(projectId: string, workspaceId: string): Promise<void> {
  const db = await getDb()
  await db.update(workspaceLives).set({ deadlineIsNextRun: true }).where(currentLifeOf(projectId, workspaceId))
}

/** Rows not recorded as stopped whose deadline is at or before `now`. */
export async function listOverdueWorkspaceRows(now: Date): Promise<WorkspaceRow[]> {
  const rows = await selectRows(await getDb())
    .where(and(isNull(workspaceLives.stoppedAt), lte(workspaceLives.deadline, now)))
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
  const rows = await selectRows(await getDb()).where(eq(workspaces.projectId, projectId))
  return new Map(rows.map((r) => [r.workspaceId, toRow(r)]))
}

/** Rows across every project (or one), for the stopped-workspace listing. */
export async function listWorkspaceRows(projectId?: string): Promise<WorkspaceRow[]> {
  const rows = await selectRows(await getDb()).where(projectId === undefined ? undefined : eq(workspaces.projectId, projectId))
  return rows.map(toRow)
}

/** What `listStoppedWorkspaceRows` narrows the stopped rows to. */
export interface StoppedRowFilter {
  /** Only these projects' rows; an empty list matches none. */
  projectIds?: string[]
  /** Ids to leave out: the ones the runtime reports running, since a
   *  restart keeps its stop until its next life starts. */
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
 * Workspaces whose current life has a recorded stop, newest stop first (the id breaks ties), one
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
  const conds: (SQL | undefined)[] = [isNotNull(workspaceLives.stoppedAt)]
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
  const stoppedMs = sql`date_trunc('milliseconds', ${workspaceLives.stoppedAt})`
  const afterMs = after && sql`${after.stoppedAt.toISOString()}::timestamptz`
  const rows = await selectRows(await getDb())
    .where(after === undefined ? where : and(where, or(
      sql`${stoppedMs} < ${afterMs}`,
      and(sql`${stoppedMs} = ${afterMs}`, lt(workspaces.workspaceId, after.workspaceId)),
    )))
    .orderBy(desc(stoppedMs), desc(workspaces.workspaceId))
    .limit(page.limit ?? Number.MAX_SAFE_INTEGER)
  const [counted] = await db.select({ n: count() }).from(workspaces).innerJoin(workspaceLives, currentLife).where(where)
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
  const died = sql`${workspaceLives.deathReason} is not null`
  const rows = await db.select({
    projectId: workspaces.projectId,
    groupId: workspaces.groupId,
    stopped: sql<number>`count(*) filter (where ${counted})`.mapWith(Number),
    deaths: sql<number>`count(*) filter (where ${died})`.mapWith(Number),
    seenBy: sql<string[][] | null>`jsonb_agg(${workspaceLives.deathSeenBy})
      filter (where ${died} and cardinality(${workspaceLives.deathSeenBy}) > 0)`,
  }).from(workspaces).innerJoin(workspaceLives, currentLife)
    .where(isNotNull(workspaceLives.stoppedAt))
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
  const rows = await selectRows(await getDb()).where(eq(workspaces.workspaceId, workspaceId))
  return rows[0] ? toRow(rows[0]) : undefined
}

/** One workspace's row, or undefined. */
export async function getWorkspaceRow(
  projectId: string,
  workspaceId: string,
): Promise<WorkspaceRow | undefined> {
  const rows = await selectRows(await getDb()).where(key(projectId, workspaceId))
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

/** Take `paths` off the scratch dirs a workspace was started with, so its
 *  stop leaves them in its checkout. A life recording none is left as is. */
export async function forgetWorkspaceScratchDirs(projectId: string, workspaceId: string, paths: string[]): Promise<void> {
  const db = await getDb()
  const [life] = await db.select({ scratchDirs: workspaceLives.scratchDirs }).from(workspaceLives)
    .where(currentLifeOf(projectId, workspaceId))
  if (!life?.scratchDirs) return
  await db.update(workspaceLives).set({ scratchDirs: life.scratchDirs.filter((d) => !paths.includes(d)) })
    .where(currentLifeOf(projectId, workspaceId))
}

/** Record `scratchDirs` for each of the project's workspaces whose current
 *  life has none recorded, all of which predate the column
 *  (docs/legacy-compat-shims.md). */
export async function backfillWorkspaceScratchDirs(projectId: string, scratchDirs: string[]): Promise<void> {
  const db = await getDb()
  await db.update(workspaceLives).set({ scratchDirs })
    .where(and(currentLifeOf(projectId), isNull(workspaceLives.scratchDirs)))
}

export async function setWorkspaceTrackedScratchDirs(
  projectId: string,
  workspaceId: string,
  trackedScratchDirs: string[],
): Promise<void> {
  const db = await getDb()
  await db.update(workspaceLives).set({ trackedScratchDirs }).where(currentLifeOf(projectId, workspaceId))
}

/**
 * Workspaces whose current life has no recorded stop, which the reaper
 * checks for a missing runtime. `ran` is true if the agent ever started (a
 * captured opening message or transcript exists), separating an interrupted
 * create from a workspace whose runtime was removed out-of-band.
 * `restartedFrom` is set while the current life is a restart that has not
 * come up: when the life before it began.
 */
export async function listLiveWorkspaceRows(): Promise<Array<{
  projectId: string
  workspaceId: string
  ran: boolean
  restartedFrom?: Date
}>> {
  const db = await getDb()
  const rows = await db.select({
    projectId: workspaces.projectId,
    workspaceId: workspaces.workspaceId,
    launchedAt: workspaceLives.launchedAt,
    lifeBefore: sql<string | null>`(select max(p.started_at) from workspace_lives p
      where p.workspace_id = workspace_lives.workspace_id and p.started_at < workspace_lives.started_at)`,
  }).from(workspaces).innerJoin(workspaceLives, currentLife).where(isNull(workspaceLives.stoppedAt))
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
    ...(r.launchedAt === null && r.lifeBefore !== null ? { restartedFrom: new Date(r.lifeBefore) } : {}),
  }))
}

/**
 * Delete a project's workspace rows, on project removal (which also deletes
 * the checkouts). The caller also runs `deleteProjectConversations`.
 */
export async function deleteProjectWorkspaces(projectId: string): Promise<void> {
  const db = await getDb()
  await db.delete(workspaces).where(eq(workspaces.projectId, projectId))
}
