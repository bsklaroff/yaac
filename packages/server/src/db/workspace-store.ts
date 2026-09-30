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
 * The workspace spine: one row per workspace id for every workspace
 * yaac has created. Reads that used to walk transcript directories, git
 * config, and four side tables come from here; the cluster stays
 * authoritative for whether a workspace is *running*, and the agent-session
 * store (its sibling) owns which conversations live inside it.
 *
 * Write discipline, in one line each:
 *  - `recordWorkspaceCreated` is the only INSERT, and never upserts: a
 *    workspace id is claimed once, across every project. It runs at every
 *    fresh create, including the one that warms a prewarmed spare — a
 *    spare's row carries `spare: true`, and `claimSpareWorkspace` is what
 *    clears it. A restart is `recordWorkspaceResumed`, an UPDATE.
 *  - Everything else is an UPDATE, which no-ops for a row that doesn't
 *    exist. That is what keeps workspaces from a foreign data dir invisible
 *    without a single existence check.
 *  - Every listing filters `spare` out, so an unclaimed spare is as
 *    invisible to the user as it was when it had no row — but, unlike then,
 *    the startup sweep can still ask what a dead pod's workspace was.
 *  - A row is written BEFORE the workspace's Job, so no pod can ever be
 *    rowless — the row is what makes a pod a session, and a pod without
 *    one is invisible to every path that reads recorded state.
 *  - No *stop* deletes a row: a `stoppedAt` row IS the stopped-workspace
 *    listing, and a restart reuses the id and clears the column. The two
 *    deletes are scoped to something other than a running workspace going
 *    away — `deleteProjectWorkspaces` (the project is gone) and
 *    `deleteWorkspaceRow` (a create that never came up, rolling back its own
 *    insert).
 *
 * `recordWorkspaceCreated` propagates its failures: the row is what makes a
 * pod a session, so a create that can't record one has not created a
 * session and must not report success. Every other write is best-effort in
 * the same sense the old stores were — a lost title or stop stamp degrades
 * a listing, and must never block a teardown. Reads propagate; a broken DB
 * there is a real error.
 */

/** A workspace row as the display paths consume it. */
export interface WorkspaceRow {
  projectSlug: string
  workspaceId: string
  createdAt: Date
  title?: string
  baseBranch?: string
  /** The sidebar group it is filed under; absent is the default list. */
  groupId?: string
  stoppedAt?: Date
  deathReason?: WorkspaceDeathReason
  deathDetail?: string
  deathSeen: boolean
  /** An unclaimed prewarmed spare. Only the point reads surface one — every
   *  listing here filters them out. */
  spare: boolean
  /** When the pod currently hosting it came up, if one is. */
  lifeStartedAt?: Date
  /** The permission posture its agents run under, as last reported — what a
   *  restart relaunches in and what `yaac-mama create` caps a sibling at. */
  permissionMode: PermissionMode
  /** The model and agent mode its first agent launched with — what a spare
   *  claim matches against. Absent on rows older than the columns. */
  model?: string
  mode?: AgentMode
}

/** Fields `recordWorkspaceCreated` stamps on a fresh workspace. */
export interface WorkspaceCreatedInput {
  projectSlug: string
  workspaceId: string
  /** Branch the workspace forked from. */
  baseBranch?: string
  /** Record it as an unclaimed prewarmed spare. Set only by warming; the
   *  flag is never cleared here, because clearing it is a claim and a claim
   *  must be able to fail (see `claimSpareWorkspace`). */
  spare?: boolean
  /** The permission posture its agents launch in. */
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

/** Every read but the point lookups excludes unclaimed spares: a spare is
 *  not a workspace, and nothing that lists, counts, or reaps workspaces should
 *  see one. */
const notSpare = eq(workspaces.spare, false)

const key = (projectSlug: string, workspaceId: string) =>
  and(eq(workspaces.projectSlug, projectSlug), eq(workspaces.workspaceId, workspaceId))

/**
 * Record a workspace as created — a plain INSERT, because a workspace id is
 * claimed exactly once. Posting an id that is already taken, in this project
 * or any other, is a `CONFLICT` that leaves the existing row as it was: an
 * upsert here re-stamped the live workspace, and the create's own failure
 * path then tore that workspace down as if it were its own.
 *
 * Throws on a failed write, and callers must treat that as a failed create:
 * a pod with no row is invisible to everything that reads recorded state
 * (the stopped listing, restart, titles), so handing one back would be
 * worse than failing.
 */
export async function recordWorkspaceCreated(input: WorkspaceCreatedInput): Promise<void> {
  const db = await getDb()
  const rows = await db.insert(workspaces)
    .values({
      projectSlug: input.projectSlug,
      workspaceId: input.workspaceId,
      ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch } : {}),
      // Only ever set here, never cleared: a claim is what clears it, and it
      // has to be able to fail loudly (a silently-missed flip would leave a
      // real workspace looking reapable).
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
 * Record a stopped workspace as coming back up: re-stamp the live fields and
 * clear the previous life's stop — a restarted workspace must not keep showing
 * as stopped (or as having died). `createdAt`, the title and the sidebar
 * group are deliberately left alone; they belong to the workspace, not to one
 * of its lives — which is what puts a restarted workspace back in the group
 * its ghost row was sitting in.
 *
 * Never inserts. A stop keeps its row, so a restartable workspace always has
 * one; a pod whose row is missing is one yaac has no record of (a reset or
 * restored DB), and `NOT_FOUND` is the right answer for it.
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
 * Turn an unclaimed spare into a workspace: clear the flag, and stamp what the
 * claimant is handed — the base branch the claim resolved and the launch the
 * agent now runs (posture, mode, model), with no stop or death from before.
 * `createdAt` becomes the claim time: the workspace is born when someone is
 * handed it, not when the pool warmed it, so the sidebar's age and order
 * match the request that made it. An UPDATE of the spare's own row, never a
 * second insert: warming claimed the id, and this hands that row over.
 *
 * The one spare write a caller must be able to fail on. The startup sweep
 * DELETES a checkout on the strength of `spare = true`, so a silently-lost
 * flip would leave a real workspace — one a user is about to be handed —
 * marked reapable, and the next server start would take their work with it.
 * So this throws where every other spare write shrugs — including when no
 * unclaimed spare row matched — and the claim runs it before touching the
 * spare, so a failure costs nothing but a cold create.
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
 * Forget a reaped spare. Guarded on the flag inside the query, so the sweep
 * that calls it cannot delete a real workspace's row even if it asks: the
 * cost of being wrong is a checkout the user expected to restart into, and
 * the guard belongs next to the column rather than at the call site.
 */
export async function deleteSpareWorkspaceRow(
  projectSlug: string,
  workspaceId: string,
): Promise<void> {
  const db = await getDb()
  await db.delete(workspaces).where(and(key(projectSlug, workspaceId), eq(workspaces.spare, true)))
}

/**
 * Put a claimed spare back to being a spare — the rollback for a claim that
 * failed before it touched the pod. Everything the claim stamped goes back
 * to `warmed`, the row as it was read before the claim: the next claim
 * decides from `model` and `permissionMode` whether the booted agent can be
 * handed over as-is, so a row still carrying the failed claim's launch would
 * hand over an agent running in another posture than the row says.
 *
 * Without this the row would have to be deleted, and a spare pod whose row is
 * gone is unreapable: `listProjectWorkspaceIds` is what the sweep collects a
 * dead spare's checkout on, so a rowless one would keep its checkout forever.
 * Re-flagging hands the pod back to the ordinary spare lifecycle instead —
 * a later claim can take it, and if none does the sweep collects it.
 *
 * The conversation the claim recorded goes too, because a spare has none: its
 * warm-time agent is pinned to its own id and belongs to nobody. Left behind,
 * that link would be an active ordinal-0 conversation on a workspace that does
 * not exist yet — and ordinal 0 is where the workspace's tool and founding ask
 * are read from, so a later claim for a *different* tool would inherit it.
 * Nothing else would ever collect it either: a spare reaped unclaimed is not
 * a failed create, so no rollback prunes its links.
 *
 * Best-effort, unlike the claim: this runs while a claim is already failing,
 * and the caller is about to fall back to a cold create either way.
 */
export async function restoreSpareWorkspace(warmed: WorkspaceRow): Promise<void> {
  const { projectSlug, workspaceId } = warmed
  try {
    await deleteWorkspaceAgentSessions(projectSlug, workspaceId)
  } catch {
    // Non-fatal, and separately caught so it cannot skip the flag below —
    // the flag is what makes the pod reapable at all.
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
 * Record that a pod has come up for this workspace, and invalidate every
 * handle the previous one left behind — in one transaction, because the two
 * are the same fact.
 *
 * A **life** is one pod. Handles restart with it — tmux pane ids at `%0`,
 * acpd sockets at the tool's name — so a handle the last life recorded would
 * name one *this* life owns, and the ACP driver re-addresses a conversation
 * by its recorded handle (`recordedConversationHandles`). Clearing them as
 * the life is stamped is what makes that impossible, and doing it atomically
 * is what stops a crash between the two halves from leaving stale handles
 * against a fresh life.
 *
 * Propagates its failures. Every other write here is best-effort, but a life
 * that was not stamped leaves a dead pod's panes on the rows, which is
 * exactly the corruption this exists to prevent — the create should fail
 * instead.
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
 * Stamp the stop time, plus the cause when a reaper (not the user) tore the
 * session down. Always writes the death columns so a reused id can't
 * inherit a stale cause, and resets `deathSeen` so a re-died workspace
 * re-flags the notification.
 *
 * Deliberately does not touch `workspace_agent_sessions.active`: freezing
 * that set as the pod's last observed state is what a restart reads back.
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

/** The stop state a row carried before a restart re-stamped it live —
 *  captured so a failed restart can put it back exactly as it was. */
export interface PriorStop {
  stoppedAt: Date
  deathReason?: WorkspaceDeathReason
  deathDetail?: string
  deathSeen: boolean
}

/** The prior stop of a row, if it had one. Read before a restart clears
 *  it, so the restart's rollback has something to restore. */
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
 * Put a row's stop back the way a restart found it. Distinct from
 * `recordWorkspaceStopped`, which stamps a *new* stop: that would replace
 * the recorded cause with nothing (an OOM-killed session whose restart
 * fails would forget it died of OOM) and re-raise the notification the user
 * already dismissed.
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
    // Non-fatal: the reaper records a row whose pod never arrived.
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
    // Non-fatal — a running workspace is excluded from the stopped listing by
    // its pod anyway.
  }
}

/** Mark an abnormal death as seen (the user opened its detail). */
export async function recordDeathSeen(projectSlug: string, workspaceId: string): Promise<void> {
  try {
    const db = await getDb()
    await db.update(workspaces).set({ deathSeen: true }).where(key(projectSlug, workspaceId))
  } catch {
    // Non-fatal — a lost write just re-shows the dot.
  }
}

/**
 * Mark every recorded abnormal death in a project seen (the user dismissed
 * the whole stopped-workspaces notification at once). Scoped to rows that
 * actually died, so it can't pre-acknowledge a death that hasn't happened.
 */
export async function recordAllDeathsSeen(projectSlug: string): Promise<void> {
  try {
    const db = await getDb()
    await db.update(workspaces).set({ deathSeen: true }).where(and(
      eq(workspaces.projectSlug, projectSlug),
      isNotNull(workspaces.deathReason),
    ))
  } catch {
    // Non-fatal — a lost write just re-shows the dot.
  }
}

/**
 * Record the bearer this workspace's `yaac-mama` will present, as a SHA-256
 * of the token itself.
 *
 * Written at launch by the runtimes whose workspaces reach the server
 * directly; nothing reads it back but `findWorkspaceByMamaToken`. No
 * notification: it changes nothing anyone renders.
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
 * Which workspace presented this token, if any — the containerless
 * attribution step, standing where the proxy's source-IP lookup stands under
 * k8s.
 *
 * Takes the token and hashes it here rather than taking a hash, so no caller
 * can be handed the shape of what is stored. A stopped workspace still
 * matches: its tmux server may be gone, but a request arriving on its token
 * is still *from* it, and the commands are scoped by project either way.
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
 *
 * `ifUntitled` makes the write conditional on the row still having no title,
 * checked in the same statement — what the title generator uses so a rename
 * landing while its model runs is never overwritten.
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

/** Every row of a project, keyed by workspace id — one query per project per
 *  list build, replacing the per-session transcript parse + git config read. */
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
 * A workspace's row by its exact id, in whichever project holds it — ids are
 * unique across projects. Unclaimed spares are not workspaces and never match.
 * Prefix expansion is `resolveWorkspace`'s, in domain, never this.
 */
export async function findWorkspaceRow(workspaceId: string): Promise<WorkspaceRow | undefined> {
  if (workspaceId === '') return undefined
  const db = await getDb()
  const rows = await db.select().from(workspaces)
    .where(and(eq(workspaces.workspaceId, workspaceId), notSpare))
  return rows[0] ? toRow(rows[0]) : undefined
}

/** One workspace's row, or undefined. The point read the reaper and any
 *  (slug, id)-keyed caller wants — the table only grows, so `listWorkspaceRows`
 *  is the wrong tool for asking about one workspace. */
export async function getWorkspaceRow(
  projectSlug: string,
  workspaceId: string,
): Promise<WorkspaceRow | undefined> {
  const db = await getDb()
  const rows = await db.select().from(workspaces).where(key(projectSlug, workspaceId))
  return rows[0] ? toRow(rows[0]) : undefined
}

/** Workspace ids that carry a recorded stop — what the stale reaper needs to
 *  tell its own teardown from an out-of-band one, without loading every row
 *  (prompts included) on every tick. */
export async function listStoppedWorkspaceIds(): Promise<Set<string>> {
  const db = await getDb()
  const rows = await db.select({
    projectSlug: workspaces.projectSlug,
    workspaceId: workspaces.workspaceId,
  }).from(workspaces).where(and(isNotNull(workspaces.stoppedAt), notSpare))
  return new Set(rows.map((r) => `${r.projectSlug}/${r.workspaceId}`))
}

/**
 * Roll back the insert of a create that failed: the workspace never came up,
 * so it should leave no trace. Scoped to that — a workspace that ever ran is
 * recorded as stopped, never removed.
 */
export async function deleteWorkspaceRow(
  projectSlug: string,
  workspaceId: string,
): Promise<void> {
  const db = await getDb()
  await db.delete(workspaces).where(key(projectSlug, workspaceId))
}

/** Record the branch the workspace forked from, once provisioning resolves
 *  it. Split from the create insert so the row can exist before the Job
 *  without waiting on the (concurrent) workspace checkout. */
export async function setWorkspaceBaseBranch(
  projectSlug: string,
  workspaceId: string,
  baseBranch: string,
): Promise<void> {
  try {
    const db = await getDb()
    await db.update(workspaces).set({ baseBranch }).where(key(projectSlug, workspaceId))
  } catch {
    // Non-fatal: the session runs, and its fork branch falls back to the
    // checkout's own upstream (workspaceForkBranch).
  }
}

/** Record a posture the running agent moved to. */
export async function setWorkspacePermissionMode(
  projectSlug: string,
  workspaceId: string,
  permissionMode: PermissionMode,
): Promise<void> {
  const db = await getDb()
  await db.update(workspaces).set({ permissionMode }).where(key(projectSlug, workspaceId))
}

/**
 * Workspaces recorded as live (no recorded stop) — the reaper's input for
 * spotting a row whose pod is gone. `ran` says whether the agent ever got
 * going: a captured opening message or a transcript on disk can only exist
 * if it did, which is what separates an interrupted create from a workspace
 * with history whose Job was removed out-of-band.
 *
 * Unclaimed spares are excluded, and that exclusion is load-bearing: the
 * reaper tears down anything in this set whose pod it cannot find, and a
 * warm spare's pod is deliberately not a workspace pod. Their own sweep
 * (`listProjectWorkspaceIds`) collects them.
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
  // Two queries rather than a correlated subquery: the link table is small
  // (one row per conversation) and this stays readable.
  //
  // The *existence* of a link proves nothing — session create records one up
  // front, before the agent is launched. Evidence that the agent actually ran
  // is a captured opening message or a transcript on disk; without either,
  // the create was interrupted before the agent got going.
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
 * Every workspace id of a project, each mapped to whether it is an unclaimed
 * spare — what the orphan sweep collects a dead spare's checkout on the
 * strength of, and what it tells a surviving log from a stray by.
 *
 * The question a spare's row exists to answer: once its pod is gone, a
 * reaped spare and a stopped workspace look identical on disk, and deleting
 * the wrong one takes a user's uncommitted work with it.
 *
 * One id-only read for the whole project, not a lookup per candidate: the
 * sweep runs every resync, and PGlite answers on the event loop, so a query
 * per stopped workspace stalls every terminal the server is relaying.
 */
export async function listProjectWorkspaceIds(projectSlug: string): Promise<Map<string, boolean>> {
  const db = await getDb()
  const rows = await db.select({ workspaceId: workspaces.workspaceId, spare: workspaces.spare })
    .from(workspaces)
    .where(eq(workspaces.projectSlug, projectSlug))
  return new Map(rows.map((r) => [r.workspaceId, r.spare]))
}

/**
 * Forget a project's workspaces. The other delete in this module, and it is
 * the project going away — not a workspace: `project remove` takes the
 * checkouts and transcripts with it, so leaving the rows would list
 * workspaces whose restart resolves into a directory that no longer exists.
 * Its conversations go too, via `deleteProjectAgentSessions` — the caller
 * runs both, since the two tables live in different stores.
 */
export async function deleteProjectWorkspaces(projectSlug: string): Promise<void> {
  const db = await getDb()
  await db.delete(workspaces).where(eq(workspaces.projectSlug, projectSlug))
}
