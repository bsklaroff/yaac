import { createHash } from 'node:crypto'
import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import { getDb } from './client'
import { deleteWorktreeAgentSessions } from './agent-session-store'
import { agentSessions, worktreeAgentSessions, worktrees } from './schema'
import { notifyWorktreeListChanged } from '#notify'
import { normalizeTitle } from '@yaac/shared/titles'
import { ServerError } from '@yaac/shared/errors'
import type {
  AgentMode,
  PermissionMode,
  WorktreeDeathCause,
  WorktreeDeathReason,
} from '@yaac/shared/types'

/**
 * The worktree spine: one row per worktree id for every worktree
 * yaac has created. Reads that used to walk transcript directories, git
 * config, and four side tables come from here; the cluster stays
 * authoritative for whether a worktree is *running*, and the agent-session
 * store (its sibling) owns which conversations live inside it.
 *
 * Write discipline, in one line each:
 *  - `recordWorktreeCreated` is the only INSERT, and never upserts: a
 *    worktree id is claimed once, across every project. It runs at every
 *    fresh create, including the one that warms a prewarmed spare — a
 *    spare's row carries `spare: true`, and `claimSpareWorktree` is what
 *    clears it. A restart is `recordWorktreeResumed`, an UPDATE.
 *  - Everything else is an UPDATE, which no-ops for a row that doesn't
 *    exist. That is what keeps worktrees from a foreign data dir invisible
 *    without a single existence check.
 *  - Every listing filters `spare` out, so an unclaimed spare is as
 *    invisible to the user as it was when it had no row — but, unlike then,
 *    the startup sweep can still ask what a dead pod's worktree was.
 *  - A row is written BEFORE the worktree's Job, so no pod can ever be
 *    rowless — the row is what makes a pod a session, and a pod without
 *    one is invisible to every path that reads recorded state.
 *  - No *stop* deletes a row: a `stoppedAt` row IS the stopped-worktree
 *    listing, and a restart reuses the id and clears the column. The two
 *    deletes are scoped to something other than a running worktree going
 *    away — `deleteProjectWorktrees` (the project is gone) and
 *    `deleteWorktreeRow` (a create that never came up, rolling back its own
 *    insert).
 *
 * `recordWorktreeCreated` propagates its failures: the row is what makes a
 * pod a session, so a create that can't record one has not created a
 * session and must not report success. Every other write is best-effort in
 * the same sense the old stores were — a lost title or stop stamp degrades
 * a listing, and must never block a teardown. Reads propagate; a broken DB
 * there is a real error.
 */

/** A worktree row as the display paths consume it. */
export interface WorktreeRow {
  projectSlug: string
  worktreeId: string
  createdAt: Date
  title?: string
  baseBranch?: string
  /** The sidebar group it is filed under; absent is the default list. */
  groupId?: string
  stoppedAt?: Date
  deathReason?: WorktreeDeathReason
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

/** Fields `recordWorktreeCreated` stamps on a fresh worktree. */
export interface WorktreeCreatedInput {
  projectSlug: string
  worktreeId: string
  /** Branch the worktree forked from. */
  baseBranch?: string
  /** Record it as an unclaimed prewarmed spare. Set only by warming; the
   *  flag is never cleared here, because clearing it is a claim and a claim
   *  must be able to fail (see `claimSpareWorktree`). */
  spare?: boolean
  /** The permission posture its agents launch in. */
  permissionMode?: PermissionMode
  /** The model and agent mode its first agent launches with. */
  model?: string
  mode?: AgentMode
}

type Row = typeof worktrees.$inferSelect

function toRow(r: Row): WorktreeRow {
  return {
    projectSlug: r.projectSlug,
    worktreeId: r.worktreeId,
    createdAt: r.createdAt,
    ...(r.title !== null ? { title: r.title } : {}),
    ...(r.baseBranch !== null ? { baseBranch: r.baseBranch } : {}),
    ...(r.groupId !== null ? { groupId: r.groupId } : {}),
    ...(r.stoppedAt !== null ? { stoppedAt: r.stoppedAt } : {}),
    ...(r.deathReason !== null ? { deathReason: r.deathReason as WorktreeDeathReason } : {}),
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
 *  not a worktree, and nothing that lists, counts, or reaps worktrees should
 *  see one. */
const notSpare = eq(worktrees.spare, false)

const key = (projectSlug: string, worktreeId: string) =>
  and(eq(worktrees.projectSlug, projectSlug), eq(worktrees.worktreeId, worktreeId))

/**
 * Record a worktree as created — a plain INSERT, because a worktree id is
 * claimed exactly once. Posting an id that is already taken, in this project
 * or any other, is a `CONFLICT` that leaves the existing row as it was: an
 * upsert here re-stamped the live worktree, and the create's own failure
 * path then tore that worktree down as if it were its own.
 *
 * Throws on a failed write, and callers must treat that as a failed create:
 * a pod with no row is invisible to everything that reads recorded state
 * (the stopped listing, restart, titles), so handing one back would be
 * worse than failing.
 */
export async function recordWorktreeCreated(input: WorktreeCreatedInput): Promise<void> {
  const db = await getDb()
  const rows = await db.insert(worktrees)
    .values({
      projectSlug: input.projectSlug,
      worktreeId: input.worktreeId,
      ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch } : {}),
      // Only ever set here, never cleared: a claim is what clears it, and it
      // has to be able to fail loudly (a silently-missed flip would leave a
      // real worktree looking reapable).
      ...(input.spare === true ? { spare: true } : {}),
      ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
    })
    .onConflictDoNothing({ target: worktrees.worktreeId })
    .returning({ worktreeId: worktrees.worktreeId })
  if (!rows[0]) {
    throw new ServerError('CONFLICT', `worktree id ${input.worktreeId} is already in use`)
  }
}

/**
 * Record a stopped worktree as coming back up: re-stamp the live fields and
 * clear the previous life's stop — a restarted worktree must not keep showing
 * as stopped (or as having died). `createdAt`, the title and the sidebar
 * group are deliberately left alone; they belong to the worktree, not to one
 * of its lives — which is what puts a restarted worktree back in the group
 * its ghost row was sitting in.
 *
 * Never inserts. A stop keeps its row, so a restartable worktree always has
 * one; a pod whose row is missing is one yaac has no record of (a reset or
 * restored DB), and `NOT_FOUND` is the right answer for it.
 */
export async function recordWorktreeResumed(
  input: Pick<WorktreeCreatedInput, 'projectSlug' | 'worktreeId' | 'permissionMode' | 'model' | 'mode'>,
): Promise<void> {
  const db = await getDb()
  const rows = await db.update(worktrees).set({
    stoppedAt: null,
    deathReason: null,
    deathDetail: null,
    deathSeen: false,
    ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
  }).where(key(input.projectSlug, input.worktreeId))
    .returning({ worktreeId: worktrees.worktreeId })
  if (!rows[0]) {
    throw new ServerError('NOT_FOUND', `worktree ${input.worktreeId} has no record to resume`)
  }
}

/**
 * Turn an unclaimed spare into a worktree: clear the flag, and stamp what the
 * claimant is handed — the base branch the claim resolved and the launch the
 * agent now runs (posture, mode, model), with no stop or death from before.
 * `createdAt` becomes the claim time: the worktree is born when someone is
 * handed it, not when the pool warmed it, so the sidebar's age and order
 * match the request that made it. An UPDATE of the spare's own row, never a
 * second insert: warming claimed the id, and this hands that row over.
 *
 * The one spare write a caller must be able to fail on. The startup sweep
 * DELETES a checkout on the strength of `spare = true`, so a silently-lost
 * flip would leave a real worktree — one a user is about to be handed —
 * marked reapable, and the next server start would take their work with it.
 * So this throws where every other spare write shrugs — including when no
 * unclaimed spare row matched — and the claim runs it before touching the
 * spare, so a failure costs nothing but a cold create.
 */
export async function claimSpareWorktree(
  projectSlug: string,
  worktreeId: string,
  claim: Pick<WorktreeCreatedInput, 'permissionMode' | 'model' | 'mode'> = {},
): Promise<void> {
  const db = await getDb()
  const rows = await db.update(worktrees).set({
    spare: false,
    createdAt: new Date(),
    stoppedAt: null,
    deathReason: null,
    deathDetail: null,
    deathSeen: false,
    ...(claim.permissionMode !== undefined ? { permissionMode: claim.permissionMode } : {}),
    ...(claim.model !== undefined ? { model: claim.model } : {}),
    ...(claim.mode !== undefined ? { mode: claim.mode } : {}),
  }).where(and(key(projectSlug, worktreeId), eq(worktrees.spare, true)))
    .returning({ worktreeId: worktrees.worktreeId })
  if (!rows[0]) {
    throw new ServerError('CONFLICT', `worktree ${worktreeId} is not an unclaimed spare`)
  }
  notifyWorktreeListChanged()
}

/**
 * Forget a reaped spare. Guarded on the flag inside the query, so the sweep
 * that calls it cannot delete a real worktree's row even if it asks: the
 * cost of being wrong is a checkout the user expected to restart into, and
 * the guard belongs next to the column rather than at the call site.
 */
export async function deleteSpareWorktreeRow(
  projectSlug: string,
  worktreeId: string,
): Promise<void> {
  const db = await getDb()
  await db.delete(worktrees).where(and(key(projectSlug, worktreeId), eq(worktrees.spare, true)))
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
 * gone is unreapable: `listProjectWorktreeIds` is what the sweep collects a
 * dead spare's checkout on, so a rowless one would keep its checkout forever.
 * Re-flagging hands the pod back to the ordinary spare lifecycle instead —
 * a later claim can take it, and if none does the sweep collects it.
 *
 * The conversation the claim recorded goes too, because a spare has none: its
 * warm-time agent is pinned to its own id and belongs to nobody. Left behind,
 * that link would be an active ordinal-0 conversation on a worktree that does
 * not exist yet — and ordinal 0 is where the worktree's tool and founding ask
 * are read from, so a later claim for a *different* tool would inherit it.
 * Nothing else would ever collect it either: a spare reaped unclaimed is not
 * a failed create, so no rollback prunes its links.
 *
 * Best-effort, unlike the claim: this runs while a claim is already failing,
 * and the caller is about to fall back to a cold create either way.
 */
export async function restoreSpareWorktree(warmed: WorktreeRow): Promise<void> {
  const { projectSlug, worktreeId } = warmed
  try {
    await deleteWorktreeAgentSessions(projectSlug, worktreeId)
  } catch {
    // Non-fatal, and separately caught so it cannot skip the flag below —
    // the flag is what makes the pod reapable at all.
  }
  try {
    const db = await getDb()
    await db.update(worktrees).set({
      spare: true,
      createdAt: warmed.createdAt,
      baseBranch: warmed.baseBranch ?? null,
      permissionMode: warmed.permissionMode,
      model: warmed.model ?? null,
      mode: warmed.mode ?? null,
    }).where(key(projectSlug, worktreeId))
  } catch {
    // Non-fatal: the worktree dir sweep still collects a checkout with no pod.
  }
}

/**
 * Record that a pod has come up for this worktree, and invalidate every
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
export async function recordWorktreeLife(
  projectSlug: string,
  worktreeId: string,
): Promise<void> {
  const db = await getDb()
  await db.transaction(async (tx) => {
    await tx.update(worktrees)
      .set({ lifeStartedAt: new Date() })
      .where(key(projectSlug, worktreeId))
    await tx.update(worktreeAgentSessions)
      .set({ paneId: null })
      .where(and(
        eq(worktreeAgentSessions.projectSlug, projectSlug),
        eq(worktreeAgentSessions.worktreeId, worktreeId),
      ))
  })
}

/**
 * Stamp the stop time, plus the cause when a reaper (not the user) tore the
 * session down. Always writes the death columns so a reused id can't
 * inherit a stale cause, and resets `deathSeen` so a re-died worktree
 * re-flags the notification.
 *
 * Deliberately does not touch `worktree_agent_sessions.active`: freezing
 * that set as the pod's last observed state is what a restart reads back.
 */
export async function recordWorktreeStopped(
  projectSlug: string,
  worktreeId: string,
  cause?: WorktreeDeathCause,
): Promise<void> {
  try {
    const db = await getDb()
    await db.update(worktrees).set({
      stoppedAt: new Date(),
      deathReason: cause?.reason ?? null,
      deathDetail: cause?.detail ?? null,
      deathSeen: false,
    }).where(key(projectSlug, worktreeId))
  } catch {
    // Non-fatal: the teardown itself is what matters.
  }
}

/** The stop state a row carried before a restart re-stamped it live —
 *  captured so a failed restart can put it back exactly as it was. */
export interface PriorStop {
  stoppedAt: Date
  deathReason?: WorktreeDeathReason
  deathDetail?: string
  deathSeen: boolean
}

/** The prior stop of a row, if it had one. Read before a restart clears
 *  it, so the restart's rollback has something to restore. */
export function priorStopOf(row: WorktreeRow | undefined): PriorStop | undefined {
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
 * `recordWorktreeStopped`, which stamps a *new* stop: that would replace
 * the recorded cause with nothing (an OOM-killed session whose restart
 * fails would forget it died of OOM) and re-raise the notification the user
 * already dismissed.
 */
export async function restoreWorktreeStop(
  projectSlug: string,
  worktreeId: string,
  prior: PriorStop,
): Promise<void> {
  try {
    const db = await getDb()
    await db.update(worktrees).set({
      stoppedAt: prior.stoppedAt,
      deathReason: prior.deathReason ?? null,
      deathDetail: prior.deathDetail ?? null,
      deathSeen: prior.deathSeen,
    }).where(key(projectSlug, worktreeId))
  } catch {
    // Non-fatal: the reaper records a row whose pod never arrived.
  }
}

/** Clear a worktree's stop (its id is live again after a restart). */
export async function clearWorktreeStopped(
  projectSlug: string,
  worktreeId: string,
): Promise<void> {
  try {
    const db = await getDb()
    await db.update(worktrees).set({
      stoppedAt: null,
      deathReason: null,
      deathDetail: null,
      deathSeen: false,
    }).where(key(projectSlug, worktreeId))
  } catch {
    // Non-fatal — a running worktree is excluded from the stopped listing by
    // its pod anyway.
  }
}

/** Mark an abnormal death as seen (the user opened its detail). */
export async function recordDeathSeen(projectSlug: string, worktreeId: string): Promise<void> {
  try {
    const db = await getDb()
    await db.update(worktrees).set({ deathSeen: true }).where(key(projectSlug, worktreeId))
  } catch {
    // Non-fatal — a lost write just re-shows the dot.
  }
}

/**
 * Mark every recorded abnormal death in a project seen (the user dismissed
 * the whole stopped-worktrees notification at once). Scoped to rows that
 * actually died, so it can't pre-acknowledge a death that hasn't happened.
 */
export async function recordAllDeathsSeen(projectSlug: string): Promise<void> {
  try {
    const db = await getDb()
    await db.update(worktrees).set({ deathSeen: true }).where(and(
      eq(worktrees.projectSlug, projectSlug),
      isNotNull(worktrees.deathReason),
    ))
  } catch {
    // Non-fatal — a lost write just re-shows the dot.
  }
}

/**
 * Record the bearer this worktree's `yaac-mama` will present, as a SHA-256
 * of the token itself.
 *
 * Written at launch by the runtimes whose workspaces reach the server
 * directly; nothing reads it back but `findWorktreeByMamaToken`. No
 * notification: it changes nothing anyone renders.
 */
export async function setWorktreeMamaTokenHash(
  projectSlug: string,
  worktreeId: string,
  hash: string,
): Promise<void> {
  const db = await getDb()
  await db.update(worktrees).set({ mamaTokenHash: hash }).where(key(projectSlug, worktreeId))
}

/**
 * Which worktree presented this token, if any — the containerless
 * attribution step, standing where the proxy's source-IP lookup stands under
 * k8s.
 *
 * Takes the token and hashes it here rather than taking a hash, so no caller
 * can be handed the shape of what is stored. A stopped worktree still
 * matches: its tmux server may be gone, but a request arriving on its token
 * is still *from* it, and the commands are scoped by project either way.
 */
export async function findWorktreeByMamaToken(
  token: string,
): Promise<{ projectSlug: string; worktreeId: string } | undefined> {
  if (token === '') return undefined
  const hash = createHash('sha256').update(token).digest('hex')
  const db = await getDb()
  const rows = await db.select({
    projectSlug: worktrees.projectSlug,
    worktreeId: worktrees.worktreeId,
  }).from(worktrees).where(eq(worktrees.mamaTokenHash, hash))
  return rows[0]
}

/**
 * Set (or, with a blank title, clear) a worktree's display title.
 *
 * `ifUntitled` makes the write conditional on the row still having no title,
 * checked in the same statement — what the title generator uses so a rename
 * landing while its model runs is never overwritten.
 */
export async function setWorktreeTitle(
  projectSlug: string,
  worktreeId: string,
  title: string,
  { ifUntitled = false }: { ifUntitled?: boolean } = {},
): Promise<void> {
  const normalized = normalizeTitle(title)
  const db = await getDb()
  await db.update(worktrees)
    .set({ title: normalized === '' ? null : normalized })
    .where(ifUntitled
      ? and(key(projectSlug, worktreeId), isNull(worktrees.title))
      : key(projectSlug, worktreeId))
  notifyWorktreeListChanged()
}

/** Every row of a project, keyed by worktree id — one query per project per
 *  list build, replacing the per-session transcript parse + git config read. */
export async function getProjectWorktreeRows(
  projectSlug: string,
): Promise<Map<string, WorktreeRow>> {
  const db = await getDb()
  const rows = await db.select().from(worktrees)
    .where(and(eq(worktrees.projectSlug, projectSlug), notSpare))
  return new Map(rows.map((r) => [r.worktreeId, toRow(r)]))
}

/** Rows across every project (or one), for the stopped-worktree listing. */
export async function listWorktreeRows(projectSlug?: string): Promise<WorktreeRow[]> {
  const db = await getDb()
  const rows = projectSlug === undefined
    ? await db.select().from(worktrees).where(notSpare)
    : await db.select().from(worktrees)
      .where(and(eq(worktrees.projectSlug, projectSlug), notSpare))
  return rows.map(toRow)
}

/**
 * A worktree's row by its exact id, in whichever project holds it — ids are
 * unique across projects. Unclaimed spares are not worktrees and never match.
 * Prefix expansion is `resolveWorktree`'s, in domain, never this.
 */
export async function findWorktreeRow(worktreeId: string): Promise<WorktreeRow | undefined> {
  if (worktreeId === '') return undefined
  const db = await getDb()
  const rows = await db.select().from(worktrees)
    .where(and(eq(worktrees.worktreeId, worktreeId), notSpare))
  return rows[0] ? toRow(rows[0]) : undefined
}

/** One worktree's row, or undefined. The point read the reaper and any
 *  (slug, id)-keyed caller wants — the table only grows, so `listWorktreeRows`
 *  is the wrong tool for asking about one worktree. */
export async function getWorktreeRow(
  projectSlug: string,
  worktreeId: string,
): Promise<WorktreeRow | undefined> {
  const db = await getDb()
  const rows = await db.select().from(worktrees).where(key(projectSlug, worktreeId))
  return rows[0] ? toRow(rows[0]) : undefined
}

/** Worktree ids that carry a recorded stop — what the stale reaper needs to
 *  tell its own teardown from an out-of-band one, without loading every row
 *  (prompts included) on every tick. */
export async function listStoppedWorktreeIds(): Promise<Set<string>> {
  const db = await getDb()
  const rows = await db.select({
    projectSlug: worktrees.projectSlug,
    worktreeId: worktrees.worktreeId,
  }).from(worktrees).where(and(isNotNull(worktrees.stoppedAt), notSpare))
  return new Set(rows.map((r) => `${r.projectSlug}/${r.worktreeId}`))
}

/**
 * Roll back the insert of a create that failed: the worktree never came up,
 * so it should leave no trace. Scoped to that — a worktree that ever ran is
 * recorded as stopped, never removed.
 */
export async function deleteWorktreeRow(
  projectSlug: string,
  worktreeId: string,
): Promise<void> {
  const db = await getDb()
  await db.delete(worktrees).where(key(projectSlug, worktreeId))
}

/** Record the branch the worktree forked from, once provisioning resolves
 *  it. Split from the create insert so the row can exist before the Job
 *  without waiting on the (concurrent) worktree checkout. */
export async function setWorktreeBaseBranch(
  projectSlug: string,
  worktreeId: string,
  baseBranch: string,
): Promise<void> {
  try {
    const db = await getDb()
    await db.update(worktrees).set({ baseBranch }).where(key(projectSlug, worktreeId))
  } catch {
    // Non-fatal: the session runs, and its fork branch falls back to the
    // checkout's own upstream (worktreeForkBranch).
  }
}

/** Record a posture the running agent moved to. */
export async function setWorktreePermissionMode(
  projectSlug: string,
  worktreeId: string,
  permissionMode: PermissionMode,
): Promise<void> {
  const db = await getDb()
  await db.update(worktrees).set({ permissionMode }).where(key(projectSlug, worktreeId))
}

/**
 * Worktrees recorded as live (no recorded stop) — the reaper's input for
 * spotting a row whose pod is gone. `ran` says whether the agent ever got
 * going: a captured opening message or a transcript on disk can only exist
 * if it did, which is what separates an interrupted create from a worktree
 * with history whose Job was removed out-of-band.
 *
 * Unclaimed spares are excluded, and that exclusion is load-bearing: the
 * reaper tears down anything in this set whose pod it cannot find, and a
 * warm spare's pod is deliberately not a worktree pod. Their own sweep
 * (`listProjectWorktreeIds`) collects them.
 */
export async function listLiveWorktreeRows(): Promise<Array<{
  projectSlug: string
  worktreeId: string
  ran: boolean
}>> {
  const db = await getDb()
  const rows = await db.select({
    projectSlug: worktrees.projectSlug,
    worktreeId: worktrees.worktreeId,
  }).from(worktrees).where(and(isNull(worktrees.stoppedAt), notSpare))
  // Two queries rather than a correlated subquery: the link table is small
  // (one row per conversation) and this stays readable.
  //
  // The *existence* of a link proves nothing — session create records one up
  // front, before the agent is launched. Evidence that the agent actually ran
  // is a captured opening message or a transcript on disk; without either,
  // the create was interrupted before the agent got going.
  const links = await db.select({
    projectSlug: worktreeAgentSessions.projectSlug,
    worktreeId: worktreeAgentSessions.worktreeId,
    firstPrompt: agentSessions.firstPrompt,
    transcriptPath: agentSessions.transcriptPath,
  }).from(worktreeAgentSessions).innerJoin(agentSessions, and(
    eq(worktreeAgentSessions.projectSlug, agentSessions.projectSlug),
    eq(worktreeAgentSessions.tool, agentSessions.tool),
    eq(worktreeAgentSessions.agentSessionId, agentSessions.agentSessionId),
  ))
  const ran = new Set(links
    .filter((l) => l.firstPrompt !== null || l.transcriptPath !== null)
    .map((l) => `${l.projectSlug}/${l.worktreeId}`))
  return rows.map((r) => ({
    projectSlug: r.projectSlug,
    worktreeId: r.worktreeId,
    ran: ran.has(`${r.projectSlug}/${r.worktreeId}`),
  }))
}

/**
 * Every worktree id of a project, each mapped to whether it is an unclaimed
 * spare — what the orphan sweep collects a dead spare's checkout on the
 * strength of, and what it tells a surviving log from a stray by.
 *
 * The question a spare's row exists to answer: once its pod is gone, a
 * reaped spare and a stopped worktree look identical on disk, and deleting
 * the wrong one takes a user's uncommitted work with it.
 *
 * One id-only read for the whole project, not a lookup per candidate: the
 * sweep runs every resync, and PGlite answers on the event loop, so a query
 * per stopped worktree stalls every terminal the server is relaying.
 */
export async function listProjectWorktreeIds(projectSlug: string): Promise<Map<string, boolean>> {
  const db = await getDb()
  const rows = await db.select({ worktreeId: worktrees.worktreeId, spare: worktrees.spare })
    .from(worktrees)
    .where(eq(worktrees.projectSlug, projectSlug))
  return new Map(rows.map((r) => [r.worktreeId, r.spare]))
}

/**
 * Forget a project's worktrees. The other delete in this module, and it is
 * the project going away — not a worktree: `project remove` takes the
 * checkouts and transcripts with it, so leaving the rows would list
 * worktrees whose restart resolves into a directory that no longer exists.
 * Its conversations go too, via `deleteProjectAgentSessions` — the caller
 * runs both, since the two tables live in different stores.
 */
export async function deleteProjectWorktrees(projectSlug: string): Promise<void> {
  const db = await getDb()
  await db.delete(worktrees).where(eq(worktrees.projectSlug, projectSlug))
}
