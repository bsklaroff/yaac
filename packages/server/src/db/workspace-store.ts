import { createHash } from 'node:crypto'
import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import { getDb } from './client'
import { deleteWorkspaceAgentSessions } from './agent-session-store'
import { agentSessions, workspaceAgentSessions, workspaces } from './schema'
import { notifyWorkspaceListChanged } from '#notify'
import { normalizeTitle } from '@yaac/shared/titles'
import { ServerError } from '@yaac/shared/errors'
import type {
  AgentMode,
  PermissionMode,
  WorkspaceDeathCause,
  WorkspaceDeathReason,
} from '@yaac/shared/types'

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
 * `recordWorkspaceCreated` throws on failure, since a create without a row
 * must not report success. Most other writes are best-effort: a lost title
 * or stop stamp degrades a listing but must never block a teardown. Reads
 * propagate errors.
 */

/** A workspace row as the display paths consume it. */
export interface WorkspaceRow {
  projectSlug: string
  workspaceId: string
  createdAt: Date
  title?: string
  baseBranch?: string
  /** The sidebar group it is filed under; absent means ungrouped. */
  groupId?: string
  stoppedAt?: Date
  deathReason?: WorkspaceDeathReason
  deathDetail?: string
  deathSeen: boolean
  /** An unclaimed prewarmed spare. Only point reads return one; listings
   *  filter them out. */
  spare: boolean
  /** When its current runtime came up, if it has one. */
  lifeStartedAt?: Date
  /** Its agents' last reported permission mode: what a restart relaunches in
   *  and what `yaac-mama create` caps a sibling at. */
  permissionMode: PermissionMode
  /** The first agent's launch model and agent mode, which a spare claim
   *  matches against. Absent on rows older than these columns. */
  model?: string
  mode?: AgentMode
}

/** Fields `recordWorkspaceCreated` stamps on a fresh workspace. */
export interface WorkspaceCreatedInput {
  projectSlug: string
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
}

type Row = typeof workspaces.$inferSelect

function toRow(r: Row): WorkspaceRow {
  return {
    projectSlug: r.projectSlug,
    workspaceId: r.workspaceId,
    createdAt: r.createdAt,
    ...(r.title !== null ? { title: r.title } : {}),
    ...(r.baseBranch !== null ? { baseBranch: r.baseBranch } : {}),
    ...(r.groupId !== null ? { groupId: r.groupId } : {}),
    ...(r.stoppedAt !== null ? { stoppedAt: r.stoppedAt } : {}),
    ...(r.deathReason !== null ? { deathReason: r.deathReason as WorkspaceDeathReason } : {}),
    ...(r.deathDetail !== null ? { deathDetail: r.deathDetail } : {}),
    deathSeen: r.deathSeen,
    spare: r.spare,
    ...(r.lifeStartedAt !== null ? { lifeStartedAt: r.lifeStartedAt } : {}),
    permissionMode: r.permissionMode as PermissionMode,
    ...(r.model !== null ? { model: r.model } : {}),
    ...(r.mode !== null ? { mode: r.mode as AgentMode } : {}),
  }
}

/** Every read except point lookups excludes unclaimed spares, which are not
 *  workspaces yet. */
const notSpare = eq(workspaces.spare, false)

const key = (projectSlug: string, workspaceId: string) =>
  and(eq(workspaces.projectSlug, projectSlug), eq(workspaces.workspaceId, workspaceId))

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
      projectSlug: input.projectSlug,
      workspaceId: input.workspaceId,
      ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch } : {}),
      ...(input.spare === true ? { spare: true } : {}),
      ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
    })
    .onConflictDoNothing({ target: workspaces.workspaceId })
    .returning({ workspaceId: workspaces.workspaceId })
  if (!rows[0]) {
    throw new ServerError('CONFLICT', `workspace id ${input.workspaceId} is already in use`)
  }
}

/**
 * Record a stopped workspace as restarting: update the launch fields and
 * clear the stop and death. `createdAt`, title and group are kept, so the
 * workspace returns to its group.
 *
 * Never inserts. Stopped workspaces keep their rows, so a missing row (for
 * example after a DB reset) is `NOT_FOUND`.
 */
export async function recordWorkspaceResumed(
  input: Pick<WorkspaceCreatedInput, 'projectSlug' | 'workspaceId' | 'permissionMode' | 'model' | 'mode'>,
): Promise<void> {
  const db = await getDb()
  const rows = await db.update(workspaces).set({
    stoppedAt: null,
    deathReason: null,
    deathDetail: null,
    deathSeen: false,
    ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
  }).where(key(input.projectSlug, input.workspaceId))
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
 * Unlike other spare writes, this throws on failure, including when no
 * unclaimed spare matched: the startup sweep deletes checkouts marked
 * `spare`, so a lost update would later delete the user's work. The claim
 * runs this before touching the spare, so a failure only costs a cold
 * create.
 */
export async function claimSpareWorkspace(
  projectSlug: string,
  workspaceId: string,
  claim: Pick<WorkspaceCreatedInput, 'permissionMode' | 'model' | 'mode'> = {},
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
  }).where(and(key(projectSlug, workspaceId), eq(workspaces.spare, true)))
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
  projectSlug: string,
  workspaceId: string,
): Promise<void> {
  const db = await getDb()
  await db.delete(workspaces).where(and(key(projectSlug, workspaceId), eq(workspaces.spare, true)))
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
 * Best-effort: the caller falls back to a cold create either way.
 */
export async function restoreSpareWorkspace(warmed: WorkspaceRow): Promise<void> {
  const { projectSlug, workspaceId } = warmed
  try {
    await deleteWorkspaceAgentSessions(projectSlug, workspaceId)
  } catch {
    // Caught separately so it can't skip restoring the flag, which is what
    // makes the spare reapable.
  }
  try {
    const db = await getDb()
    await db.update(workspaces).set({
      spare: true,
      createdAt: warmed.createdAt,
      baseBranch: warmed.baseBranch ?? null,
      permissionMode: warmed.permissionMode,
      model: warmed.model ?? null,
      mode: warmed.mode ?? null,
    }).where(key(projectSlug, workspaceId))
  } catch {
    // Non-fatal: the workspace dir sweep still collects a checkout with no pod.
  }
}

/**
 * Record that a new runtime (a "life") has come up, and clear every handle
 * the previous life recorded, in one transaction. Handles restart with each
 * life (tmux pane ids at `%0`, acpd sockets at the tool's name), so an old
 * handle would name something in the new life, and the ACP driver
 * re-addresses conversations by recorded handle
 * (`recordedConversationHandles`).
 *
 * Throws on failure, unlike most writes here: stale handles are the
 * corruption this prevents, so the create should fail instead.
 */
export async function recordWorkspaceLife(
  projectSlug: string,
  workspaceId: string,
): Promise<void> {
  const db = await getDb()
  await db.transaction(async (tx) => {
    await tx.update(workspaces)
      .set({ lifeStartedAt: new Date() })
      .where(key(projectSlug, workspaceId))
    await tx.update(workspaceAgentSessions)
      .set({ paneId: null })
      .where(and(
        eq(workspaceAgentSessions.projectSlug, projectSlug),
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
  projectSlug: string,
  workspaceId: string,
  cause?: WorkspaceDeathCause,
): Promise<void> {
  try {
    const db = await getDb()
    await db.update(workspaces).set({
      stoppedAt: new Date(),
      deathReason: cause?.reason ?? null,
      deathDetail: cause?.detail ?? null,
      deathSeen: false,
    }).where(key(projectSlug, workspaceId))
  } catch {
    // Non-fatal: the teardown itself is what matters.
  }
}

/** A row's stop state before a restart cleared it, so a failed restart can
 *  restore it. */
export interface PriorStop {
  stoppedAt: Date
  deathReason?: WorkspaceDeathReason
  deathDetail?: string
  deathSeen: boolean
}

/** The row's stop state, if it is stopped. */
export function priorStopOf(row: WorkspaceRow | undefined): PriorStop | undefined {
  if (row?.stoppedAt === undefined) return undefined
  return {
    stoppedAt: row.stoppedAt,
    ...(row.deathReason !== undefined ? { deathReason: row.deathReason } : {}),
    ...(row.deathDetail !== undefined ? { deathDetail: row.deathDetail } : {}),
    deathSeen: row.deathSeen,
  }
}

/**
 * Restore a row's stop as the restart found it. `recordWorkspaceStopped`
 * would instead drop the recorded cause (e.g. an OOM) and re-raise a
 * notification the user already dismissed.
 */
export async function restoreWorkspaceStop(
  projectSlug: string,
  workspaceId: string,
  prior: PriorStop,
): Promise<void> {
  try {
    const db = await getDb()
    await db.update(workspaces).set({
      stoppedAt: prior.stoppedAt,
      deathReason: prior.deathReason ?? null,
      deathDetail: prior.deathDetail ?? null,
      deathSeen: prior.deathSeen,
    }).where(key(projectSlug, workspaceId))
  } catch {
    // Non-fatal: the reaper handles a row whose runtime never arrived.
  }
}

/** Clear a workspace's stop (its id is live again after a restart). */
export async function clearWorkspaceStopped(
  projectSlug: string,
  workspaceId: string,
): Promise<void> {
  try {
    const db = await getDb()
    await db.update(workspaces).set({
      stoppedAt: null,
      deathReason: null,
      deathDetail: null,
      deathSeen: false,
    }).where(key(projectSlug, workspaceId))
  } catch {
    // Non-fatal: a running workspace is excluded from the stopped listing
    // anyway.
  }
}

/** Mark an abnormal death as seen (the user opened its detail). */
export async function recordDeathSeen(projectSlug: string, workspaceId: string): Promise<void> {
  try {
    const db = await getDb()
    await db.update(workspaces).set({ deathSeen: true }).where(key(projectSlug, workspaceId))
  } catch {
    // Non-fatal: a lost write just re-shows the dot.
  }
}

/**
 * Mark every recorded abnormal death in a project as seen ("mark all as
 * read"). Only rows that actually died are touched.
 */
export async function recordAllDeathsSeen(projectSlug: string): Promise<void> {
  try {
    const db = await getDb()
    await db.update(workspaces).set({ deathSeen: true }).where(and(
      eq(workspaces.projectSlug, projectSlug),
      isNotNull(workspaces.deathReason),
    ))
  } catch {
    // Non-fatal: a lost write just re-shows the dot.
  }
}

/**
 * Store the SHA-256 of the bearer token this workspace's `yaac-mama` will
 * present. Written at launch for runtimes whose workspaces reach the server
 * directly (containerless). No notification, since nothing rendered changes.
 */
export async function setWorkspaceMamaTokenHash(
  projectSlug: string,
  workspaceId: string,
  hash: string,
): Promise<void> {
  const db = await getDb()
  await db.update(workspaces).set({ mamaTokenHash: hash }).where(key(projectSlug, workspaceId))
}

/**
 * Which workspace owns this `yaac-mama` token, if any. Under containerless
 * this identifies the caller, as the proxy's source-IP lookup does under k8s.
 * Hashes the token here so callers never handle the stored form. A stopped
 * workspace still matches; commands are project-scoped either way.
 */
export async function findWorkspaceByMamaToken(
  token: string,
): Promise<{ projectSlug: string; workspaceId: string } | undefined> {
  if (token === '') return undefined
  const hash = createHash('sha256').update(token).digest('hex')
  const db = await getDb()
  const rows = await db.select({
    projectSlug: workspaces.projectSlug,
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
  projectSlug: string,
  workspaceId: string,
  title: string,
  { ifUntitled = false }: { ifUntitled?: boolean } = {},
): Promise<void> {
  const normalized = normalizeTitle(title)
  const db = await getDb()
  await db.update(workspaces)
    .set({ title: normalized === '' ? null : normalized })
    .where(ifUntitled
      ? and(key(projectSlug, workspaceId), isNull(workspaces.title))
      : key(projectSlug, workspaceId))
  notifyWorkspaceListChanged()
}

/** Every row of a project, keyed by workspace id, in one query. */
export async function getProjectWorkspaceRows(
  projectSlug: string,
): Promise<Map<string, WorkspaceRow>> {
  const db = await getDb()
  const rows = await db.select().from(workspaces)
    .where(and(eq(workspaces.projectSlug, projectSlug), notSpare))
  return new Map(rows.map((r) => [r.workspaceId, toRow(r)]))
}

/** Rows across every project (or one), for the stopped-workspace listing. */
export async function listWorkspaceRows(projectSlug?: string): Promise<WorkspaceRow[]> {
  const db = await getDb()
  const rows = projectSlug === undefined
    ? await db.select().from(workspaces).where(notSpare)
    : await db.select().from(workspaces)
      .where(and(eq(workspaces.projectSlug, projectSlug), notSpare))
  return rows.map(toRow)
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
  projectSlug: string,
  workspaceId: string,
): Promise<WorkspaceRow | undefined> {
  const db = await getDb()
  const rows = await db.select().from(workspaces).where(key(projectSlug, workspaceId))
  return rows[0] ? toRow(rows[0]) : undefined
}

/** `<slug>/<id>` of workspaces with a recorded stop, which the stale reaper
 *  uses to tell its own teardowns from out-of-band ones. */
export async function listStoppedWorkspaceIds(): Promise<Set<string>> {
  const db = await getDb()
  const rows = await db.select({
    projectSlug: workspaces.projectSlug,
    workspaceId: workspaces.workspaceId,
  }).from(workspaces).where(and(isNotNull(workspaces.stoppedAt), notSpare))
  return new Set(rows.map((r) => `${r.projectSlug}/${r.workspaceId}`))
}

/**
 * Roll back a failed create's insert. Only for workspaces that never came
 * up; one that ran is recorded as stopped instead.
 */
export async function deleteWorkspaceRow(
  projectSlug: string,
  workspaceId: string,
): Promise<void> {
  const db = await getDb()
  await db.delete(workspaces).where(key(projectSlug, workspaceId))
}

/** Record the branch the workspace forked from, for a claimed spare that was
 *  re-branched. */
export async function setWorkspaceBaseBranch(
  projectSlug: string,
  workspaceId: string,
  baseBranch: string,
): Promise<void> {
  try {
    const db = await getDb()
    await db.update(workspaces).set({ baseBranch }).where(key(projectSlug, workspaceId))
  } catch {
    // Non-fatal: the fork branch falls back to the checkout's upstream
    // (workspaceForkBranch).
  }
}

/** Record the permission mode the running agent moved to. */
export async function setWorkspacePermissionMode(
  projectSlug: string,
  workspaceId: string,
  permissionMode: PermissionMode,
): Promise<void> {
  const db = await getDb()
  await db.update(workspaces).set({ permissionMode }).where(key(projectSlug, workspaceId))
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
  projectSlug: string
  workspaceId: string
  ran: boolean
}>> {
  const db = await getDb()
  const rows = await db.select({
    projectSlug: workspaces.projectSlug,
    workspaceId: workspaces.workspaceId,
  }).from(workspaces).where(and(isNull(workspaces.stoppedAt), notSpare))
  // A link alone proves nothing, since create records one before launching
  // the agent; a prompt or transcript does.
  const links = await db.select({
    projectSlug: workspaceAgentSessions.projectSlug,
    workspaceId: workspaceAgentSessions.workspaceId,
    firstPrompt: agentSessions.firstPrompt,
    transcriptPath: agentSessions.transcriptPath,
  }).from(workspaceAgentSessions).innerJoin(agentSessions, and(
    eq(workspaceAgentSessions.projectSlug, agentSessions.projectSlug),
    eq(workspaceAgentSessions.tool, agentSessions.tool),
    eq(workspaceAgentSessions.agentSessionId, agentSessions.agentSessionId),
  ))
  const ran = new Set(links
    .filter((l) => l.firstPrompt !== null || l.transcriptPath !== null)
    .map((l) => `${l.projectSlug}/${l.workspaceId}`))
  return rows.map((r) => ({
    projectSlug: r.projectSlug,
    workspaceId: r.workspaceId,
    ran: ran.has(`${r.projectSlug}/${r.workspaceId}`),
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
export async function listProjectWorkspaceIds(projectSlug: string): Promise<Map<string, boolean>> {
  const db = await getDb()
  const rows = await db.select({ workspaceId: workspaces.workspaceId, spare: workspaces.spare })
    .from(workspaces)
    .where(eq(workspaces.projectSlug, projectSlug))
  return new Map(rows.map((r) => [r.workspaceId, r.spare]))
}

/**
 * Delete a project's workspace rows, on project removal (which also deletes
 * the checkouts). The caller also runs `deleteProjectAgentSessions`.
 */
export async function deleteProjectWorkspaces(projectSlug: string): Promise<void> {
  const db = await getDb()
  await db.delete(workspaces).where(eq(workspaces.projectSlug, projectSlug))
}
