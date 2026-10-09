import { createHash } from 'node:crypto'
import { and, count, desc, eq, exists, ilike, isNotNull, isNull, lt, notInArray, or, sql, type SQL } from 'drizzle-orm'
import { getDb } from './client'
import { deleteWorkspaceAgentSessions } from './agent-session-store'
import { agentSessions, workspaceAgentSessions, workspaces } from './schema'
import { notifyWorkspaceListChanged } from '#notify'
import { normalizeTitle } from '@yaac/shared/titles'
import { ServerError } from '@yaac/shared/errors'
import { nullsToUndefined, type NullsToUndefined } from '#lib/nulls'
import type { AgentMode, PermissionMode, WorkspaceDeathCause } from '@yaac/shared/types'

/**
 * One row per workspace yaac has created. The runtime is authoritative for
 * whether a workspace is running; the agent-session store holds its
 * conversations.
 *
 * Write rules:
 *  - `recordWorkspaceCreated` is the only INSERT and never upserts: an id is
 *    claimed once across all projects. It also runs when warming a spare
 *    (`spare: true`, cleared by `claimSpareWorkspace`). A restart is
 *    `recordWorkspaceResumed`, an UPDATE.
 *  - Everything else is an UPDATE, which no-ops for a missing row, so
 *    workspaces from a foreign data dir stay invisible without checks.
 *  - Listings filter out spares, but the startup sweep can still look up a
 *    dead spare's row.
 *  - The row is written before the runtime starts, so every runtime has
 *    one; a runtime without a row is invisible to everything that reads
 *    recorded state.
 *  - A stop never deletes a row: rows with `stoppedAt` are the stopped
 *    listing, and a restart clears it. Rows are deleted only when the project
 *    is removed (`deleteProjectWorkspaces`) or a create that never came up
 *    rolls back (`deleteWorkspaceRow`).
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
  /** Record it as an unclaimed prewarmed spare. Set only when warming; only
   *  `claimSpareWorkspace` clears it. */
  spare?: boolean
  /** The permission mode its agents launch in. */
  permissionMode?: PermissionMode
  /** The model and agent mode its first agent launches with. */
  model?: string
  mode?: AgentMode
  /** The effort its agents launch at. */
  effort?: string
  /** The zone it launches with as `TZ`. */
  timeZone?: string
}

type Row = typeof workspaces.$inferSelect

/** A workspace row as the display paths consume it (columns documented in
 *  schema.ts). Only point reads return a spare; listings filter them out. */
export type WorkspaceRow = NullsToUndefined<Omit<Row, 'mamaTokenHash'>>

function toRow({ mamaTokenHash: _, ...r }: Row): WorkspaceRow {
  return nullsToUndefined(r)
}

/** Every read except point lookups excludes unclaimed spares, which are not
 *  workspaces yet. */
const notSpare = eq(workspaces.spare, false)

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
  const rows = await db.insert(workspaces)
    .values({
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch } : {}),
      ...(input.spare === true ? { spare: true } : {}),
      ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.timeZone !== undefined ? { timeZone: input.timeZone } : {}),
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
    'projectId' | 'workspaceId' | 'permissionMode' | 'model' | 'mode' | 'effort' | 'timeZone'
  >,
): Promise<void> {
  const db = await getDb()
  const rows = await db.update(workspaces).set({
    ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
    ...(input.effort !== undefined ? { effort: input.effort } : {}),
    // A resume launches a new process, in the zone the create read now.
    timeZone: input.timeZone ?? null,
  }).where(key(input.projectId, input.workspaceId))
    .returning({ workspaceId: workspaces.workspaceId })
  if (!rows[0]) {
    throw new ServerError('NOT_FOUND', `workspace ${input.workspaceId} has no record to resume`)
  }
}

/**
 * Turn an unclaimed spare into a workspace: clear the flag, clear any stop
 * or death, and stamp the claimed launch (permission mode, model, agent
 * mode). `createdAt` becomes the claim time, so the sidebar's age and order
 * match the request. (The base branch arrives separately, via
 * `base-branch-resolved`.)
 *
 * Throws when no unclaimed spare matched: the startup sweep deletes checkouts marked
 * `spare`, so a lost update would later delete the user's work. The claim
 * runs this before touching the spare, so a failure only costs a cold
 * create.
 */
export async function claimSpareWorkspace(
  projectId: string,
  workspaceId: string,
  claim: Pick<WorkspaceCreatedInput, 'permissionMode' | 'model' | 'mode' | 'effort'> = {},
): Promise<void> {
  const db = await getDb()
  const rows = await db.update(workspaces).set({
    spare: false,
    createdAt: new Date(),
    stoppedAt: null,
    deathReason: null,
    deathDetail: null,
    deathSeen: false,
    ...(claim.permissionMode !== undefined ? { permissionMode: claim.permissionMode } : {}),
    ...(claim.model !== undefined ? { model: claim.model } : {}),
    ...(claim.mode !== undefined ? { mode: claim.mode } : {}),
    // The claimed model may have no effort setting, so this always writes.
    effort: claim.effort ?? null,
  }).where(and(key(projectId, workspaceId), eq(workspaces.spare, true)))
    .returning({ workspaceId: workspaces.workspaceId })
  if (!rows[0]) {
    throw new ServerError('CONFLICT', `workspace ${workspaceId} is not an unclaimed spare`)
  }
  notifyWorkspaceListChanged()
}

/**
 * Delete a reaped spare's row. The query itself requires `spare = true`, so
 * it can never delete a real workspace's row.
 */
export async function deleteSpareWorkspaceRow(
  projectId: string,
  workspaceId: string,
): Promise<void> {
  const db = await getDb()
  await db.delete(workspaces).where(and(key(projectId, workspaceId), eq(workspaces.spare, true)))
}

/**
 * Roll back a claim that failed before touching the runtime: restore the row
 * to `warmed` (as read before the claim). The next claim checks `model` and
 * `permissionMode` to decide if the running agent can be handed over, so the
 * failed claim's values must not remain. Deleting the row instead would make
 * the spare unreapable, since the sweep finds dead spares through
 * `listProjectWorkspaceIds`.
 *
 * Also deletes the conversations the claim recorded. Otherwise a later claim
 * for a different tool would inherit an active ordinal-0 conversation (where
 * the tool and founding prompt are read), and nothing else would prune it.
 *
 * Restores the flag first, since that is what makes the spare reapable.
 */
export async function restoreSpareWorkspace(warmed: WorkspaceRow): Promise<void> {
  const { projectId, workspaceId } = warmed
  const db = await getDb()
  await db.update(workspaces).set({
    spare: true,
    createdAt: warmed.createdAt,
    baseBranch: warmed.baseBranch ?? null,
    permissionMode: warmed.permissionMode,
    model: warmed.model ?? null,
    mode: warmed.mode ?? null,
    effort: warmed.effort ?? null,
  }).where(key(projectId, workspaceId))
  await deleteWorkspaceAgentSessions(projectId, workspaceId)
}

/**
 * Record that a new runtime (a "life") has come up, and clear every handle
 * the previous life recorded, in one transaction. Handles restart with each
 * life (tmux pane ids at `%0`, acpd sockets at the tool's name), so an old
 * handle would name something in the new life, and the ACP driver
 * re-addresses conversations by recorded handle
 * (`recordedConversationHandles`).
 */
export async function recordWorkspaceLife(
  projectId: string,
  workspaceId: string,
): Promise<void> {
  const db = await getDb()
  await db.transaction(async (tx) => {
    await tx.update(workspaces)
      .set({ lifeStartedAt: new Date() })
      .where(key(projectId, workspaceId))
    await tx.update(workspaceAgentSessions)
      .set({ paneId: null })
      .where(and(
        eq(workspaceAgentSessions.projectId, projectId),
        eq(workspaceAgentSessions.workspaceId, workspaceId),
      ))
  })
}

/**
 * Stamp the stop time, plus the cause when a reaper (not the user) stopped
 * it. Always writes the death columns so a stale cause can't carry over, and
 * resets `deathSeen` so a new death shows the notification again.
 *
 * Leaves `workspace_agent_sessions.active` alone: that last observed set is
 * what a restart brings back.
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
    deathSeen: false,
  }).where(key(projectId, workspaceId))
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
    deathSeen: false,
  }).where(key(projectId, workspaceId))
}

/** Mark an abnormal death as seen (the user opened its detail). Notifies,
 *  since the snapshot counts unseen deaths. */
export async function recordDeathSeen(projectId: string, workspaceId: string): Promise<void> {
  const db = await getDb()
  await db.update(workspaces).set({ deathSeen: true }).where(key(projectId, workspaceId))
  notifyWorkspaceListChanged()
}

/**
 * Mark every recorded abnormal death in a project as seen ("mark all as
 * read"). Only rows that actually died are touched. Notifies, like
 * `recordDeathSeen`.
 */
export async function recordAllDeathsSeen(projectId: string): Promise<void> {
  const db = await getDb()
  await db.update(workspaces).set({ deathSeen: true }).where(and(
    eq(workspaces.projectId, projectId),
    isNotNull(workspaces.deathReason),
  ))
  notifyWorkspaceListChanged()
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
export async function findWorkspaceByMamaToken(
  token: string,
): Promise<{ projectId: string; workspaceId: string } | undefined> {
  if (token === '') return undefined
  const hash = createHash('sha256').update(token).digest('hex')
  const db = await getDb()
  const rows = await db.select({
    projectId: workspaces.projectId,
    workspaceId: workspaces.workspaceId,
  }).from(workspaces).where(eq(workspaces.mamaTokenHash, hash))
  return rows[0]
}

/**
 * Set (or, with a blank title, clear) a workspace's display title.
 * `ifUntitled` writes only if the row still has no title, checked in the same
 * statement, so the title generator never overwrites a rename made while it
 * ran.
 */
export async function setWorkspaceTitle(
  projectId: string,
  workspaceId: string,
  title: string,
  { ifUntitled = false }: { ifUntitled?: boolean } = {},
): Promise<void> {
  const normalized = normalizeTitle(title)
  const db = await getDb()
  await db.update(workspaces)
    .set({ title: normalized === '' ? null : normalized })
    .where(ifUntitled
      ? and(key(projectId, workspaceId), isNull(workspaces.title))
      : key(projectId, workspaceId))
  notifyWorkspaceListChanged()
}

/** Every row of a project, keyed by workspace id, in one query. */
export async function getProjectWorkspaceRows(
  projectId: string,
): Promise<Map<string, WorkspaceRow>> {
  const db = await getDb()
  const rows = await db.select().from(workspaces)
    .where(and(eq(workspaces.projectId, projectId), notSpare))
  return new Map(rows.map((r) => [r.workspaceId, toRow(r)]))
}

/** Rows across every project (or one), for the stopped-workspace listing. */
export async function listWorkspaceRows(projectId?: string): Promise<WorkspaceRow[]> {
  const db = await getDb()
  const rows = projectId === undefined
    ? await db.select().from(workspaces).where(notSpare)
    : await db.select().from(workspaces)
      .where(and(eq(workspaces.projectId, projectId), notSpare))
  return rows.map(toRow)
}

/** What `listStoppedWorkspaceRows` narrows the stopped rows to. */
export interface StoppedRowFilter {
  projectId?: string
  /** Ids to leave out: the ones the runtime reports running, since a
   *  restart keeps its stop until it succeeds. */
  excludeIds?: string[]
  /** Matched case-insensitively against the title, and the first prompt and
   *  tool of each of the workspace's conversations. */
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
 *
 * A prompt the capture step never stored is matched by `q` only once the
 * listing has backfilled it (`stoppedPrompt`).
 */
export async function listStoppedWorkspaceRows(
  filter: StoppedRowFilter,
  page: { limit?: number; after?: StoppedRowCursor } = {},
): Promise<{ rows: WorkspaceRow[]; total: number }> {
  const db = await getDb()
  const conds: (SQL | undefined)[] = [isNotNull(workspaces.stoppedAt), notSpare]
  if (filter.projectId !== undefined) conds.push(eq(workspaces.projectId, filter.projectId))
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
      exists(db.select({ one: sql`1` }).from(workspaceAgentSessions)
        .innerJoin(agentSessions, and(
          eq(workspaceAgentSessions.projectId, agentSessions.projectId),
          eq(workspaceAgentSessions.tool, agentSessions.tool),
          eq(workspaceAgentSessions.agentSessionId, agentSessions.agentSessionId),
        ))
        .where(and(
          eq(workspaceAgentSessions.projectId, workspaces.projectId),
          eq(workspaceAgentSessions.workspaceId, workspaces.workspaceId),
          or(ilike(agentSessions.firstPrompt, pattern), ilike(agentSessions.tool, pattern)),
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
  stopped: number
  /** Deaths the user has not viewed yet. */
  unseenDeaths: number
}

export async function countStoppedWorkspaces(): Promise<StoppedCount[]> {
  const db = await getDb()
  return db.select({
    projectId: workspaces.projectId,
    groupId: workspaces.groupId,
    stopped: count(),
    unseenDeaths: sql<number>`count(*) filter (where ${workspaces.deathReason} is not null and not ${workspaces.deathSeen})`
      .mapWith(Number),
  }).from(workspaces)
    .where(and(isNotNull(workspaces.stoppedAt), notSpare))
    .groupBy(workspaces.projectId, workspaces.groupId)
}

/**
 * A workspace's row by exact id, in whichever project holds it (ids are
 * unique across projects). Unclaimed spares never match. Prefix matching is
 * done by `resolveWorkspace` in domain.
 */
export async function findWorkspaceRow(workspaceId: string): Promise<WorkspaceRow | undefined> {
  if (workspaceId === '') return undefined
  const db = await getDb()
  const rows = await db.select().from(workspaces)
    .where(and(eq(workspaces.workspaceId, workspaceId), notSpare))
  return rows[0] ? toRow(rows[0]) : undefined
}

/** One workspace's row, or undefined. Includes spares. */
export async function getWorkspaceRow(
  projectId: string,
  workspaceId: string,
): Promise<WorkspaceRow | undefined> {
  const db = await getDb()
  const rows = await db.select().from(workspaces).where(key(projectId, workspaceId))
  return rows[0] ? toRow(rows[0]) : undefined
}

/** `<projectId>/<id>` of workspaces with a recorded stop, which the stale reaper
 *  uses to tell its own teardowns from out-of-band ones. */
export async function listStoppedWorkspaceIds(): Promise<Set<string>> {
  const db = await getDb()
  const rows = await db.select({
    projectId: workspaces.projectId,
    workspaceId: workspaces.workspaceId,
  }).from(workspaces).where(and(isNotNull(workspaces.stoppedAt), notSpare))
  return new Set(rows.map((r) => `${r.projectId}/${r.workspaceId}`))
}

/**
 * Roll back a failed create's insert. Only for workspaces that never came
 * up; one that ran is recorded as stopped instead.
 */
export async function deleteWorkspaceRow(
  projectId: string,
  workspaceId: string,
): Promise<void> {
  const db = await getDb()
  await db.delete(workspaces).where(key(projectId, workspaceId))
}

/** Record the branch the workspace forked from, for a claimed spare that was
 *  re-branched. */
export async function setWorkspaceBaseBranch(
  projectId: string,
  workspaceId: string,
  baseBranch: string,
): Promise<void> {
  const db = await getDb()
  await db.update(workspaces).set({ baseBranch }).where(key(projectId, workspaceId))
}

/** Record the permission mode the running agent moved to. */
export async function setWorkspacePermissionMode(
  projectId: string,
  workspaceId: string,
  permissionMode: PermissionMode,
): Promise<void> {
  const db = await getDb()
  await db.update(workspaces).set({ permissionMode }).where(key(projectId, workspaceId))
}

/** Record the effort level the running agent moved to. */
export async function setWorkspaceEffort(
  projectId: string,
  workspaceId: string,
  effort: string,
): Promise<void> {
  const db = await getDb()
  await db.update(workspaces).set({ effort }).where(key(projectId, workspaceId))
}

/**
 * Workspaces with no recorded stop, which the reaper checks for a missing
 * runtime. `ran` is true if the agent ever started (a captured opening
 * message or transcript exists), separating an interrupted create from a
 * workspace whose runtime was removed out-of-band.
 *
 * Unclaimed spares must be excluded: the reaper tears down anything here
 * without a workspace runtime. Spares have their own sweep
 * (`listProjectWorkspaceIds`).
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
  }).from(workspaces).where(and(isNull(workspaces.stoppedAt), notSpare))
  // A link alone proves nothing, since create records one before launching
  // the agent; a prompt or transcript does.
  const links = await db.select({
    projectId: workspaceAgentSessions.projectId,
    workspaceId: workspaceAgentSessions.workspaceId,
    firstPrompt: agentSessions.firstPrompt,
    transcriptPath: agentSessions.transcriptPath,
  }).from(workspaceAgentSessions).innerJoin(agentSessions, and(
    eq(workspaceAgentSessions.projectId, agentSessions.projectId),
    eq(workspaceAgentSessions.tool, agentSessions.tool),
    eq(workspaceAgentSessions.agentSessionId, agentSessions.agentSessionId),
  ))
  const ran = new Set(links
    .filter((l) => l.firstPrompt !== null || l.transcriptPath !== null)
    .map((l) => `${l.projectId}/${l.workspaceId}`))
  return rows.map((r) => ({
    projectId: r.projectId,
    workspaceId: r.workspaceId,
    ran: ran.has(`${r.projectId}/${r.workspaceId}`),
  }))
}

/**
 * Every workspace id of a project, mapped to whether it is an unclaimed
 * spare. The orphan sweep uses this to delete dead spares' checkouts: on disk
 * a reaped spare and a stopped workspace look the same, and deleting the
 * wrong one loses the user's uncommitted work.
 *
 * One query for the whole project, since PGlite runs on the event loop and a
 * query per candidate would stall terminal relaying.
 */
export async function listProjectWorkspaceIds(projectId: string): Promise<Map<string, boolean>> {
  const db = await getDb()
  const rows = await db.select({ workspaceId: workspaces.workspaceId, spare: workspaces.spare })
    .from(workspaces)
    .where(eq(workspaces.projectId, projectId))
  return new Map(rows.map((r) => [r.workspaceId, r.spare]))
}

/**
 * Delete a project's workspace rows, on project removal (which also deletes
 * the checkouts). The caller also runs `deleteProjectAgentSessions`.
 */
export async function deleteProjectWorkspaces(projectId: string): Promise<void> {
  const db = await getDb()
  await db.delete(workspaces).where(eq(workspaces.projectId, projectId))
}
