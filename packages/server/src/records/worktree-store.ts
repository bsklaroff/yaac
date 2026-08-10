import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import { agentSessions, getDb, worktreeAgentSessions, worktrees } from '#platform/db'
import { normalizeTitle } from '@yaac/shared/titles'
import type { WorktreeDeathCause, WorktreeDeathReason } from '@yaac/shared/types'

/**
 * The worktree spine: one row per (project, worktree id) for every worktree
 * yaac has created. Reads that used to walk transcript directories, git
 * config, and four side tables come from here; the cluster stays
 * authoritative for whether a worktree is *running*, and the agent-session
 * store (its sibling) owns which conversations live inside it.
 *
 * Write discipline, in one line each:
 *  - `recordWorktreeCreated` is the only INSERT. It runs at session create
 *    and at a prewarmed spare's claim — never when a spare is warmed, so a
 *    reaped spare leaves nothing behind.
 *  - Everything else is an UPDATE, which no-ops for a row that doesn't
 *    exist. That is what keeps spares (and worktrees from a foreign data
 *    dir) invisible without a single existence check.
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
  background: boolean
  stoppedAt?: Date
  deathReason?: WorktreeDeathReason
  deathDetail?: string
  deathSeen: boolean
}

/** Fields `recordWorktreeCreated` stamps on a fresh (or restarted) worktree. */
export interface WorktreeCreatedInput {
  projectSlug: string
  worktreeId: string
  /** Branch the worktree forked from. Omitted when resuming onto an
   *  existing worktree, whose recorded base is left untouched. */
  baseBranch?: string
  /** When the worktree came into being. Defaults to now; the startup
   *  adoption of pre-existing worktrees passes the transcript's birth time
   *  instead. Never overwritten by a later re-record, so a restart doesn't
   *  reset the worktree's age. */
  createdAt?: Date
}

type Row = typeof worktrees.$inferSelect

function toRow(r: Row): WorktreeRow {
  return {
    projectSlug: r.projectSlug,
    worktreeId: r.worktreeId,
    createdAt: r.createdAt,
    ...(r.title !== null ? { title: r.title } : {}),
    ...(r.baseBranch !== null ? { baseBranch: r.baseBranch } : {}),
    background: r.background,
    ...(r.stoppedAt !== null ? { stoppedAt: r.stoppedAt } : {}),
    ...(r.deathReason !== null ? { deathReason: r.deathReason as WorktreeDeathReason } : {}),
    ...(r.deathDetail !== null ? { deathDetail: r.deathDetail } : {}),
    deathSeen: r.deathSeen,
  }
}

const key = (projectSlug: string, worktreeId: string) =>
  and(eq(worktrees.projectSlug, projectSlug), eq(worktrees.worktreeId, worktreeId))

/**
 * Record a worktree as created. Also the restart path: the id is reused, so
 * this re-stamps the live fields and clears the previous life's stop — a
 * restarted worktree must not keep showing as stopped (or as having died).
 * Title and background pin are deliberately left alone; they belong to the
 * worktree, not to one of its lives.
 *
 * Throws on a failed write, and callers must treat that as a failed create:
 * a pod with no row is invisible to everything that reads recorded state
 * (the stopped listing, restart, titles), so handing one back would be
 * worse than failing.
 */
export async function recordWorktreeCreated(input: WorktreeCreatedInput): Promise<void> {
  const db = await getDb()
  // `createdAt` is deliberately absent here: it belongs to the worktree,
  // not to the life being started, so a restart keeps the original.
  const live = {
    stoppedAt: null,
    deathReason: null,
    deathDetail: null,
    deathSeen: false,
    ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch } : {}),
  }
  await db.insert(worktrees)
    .values({
      projectSlug: input.projectSlug,
      worktreeId: input.worktreeId,
      createdAt: input.createdAt ?? new Date(),
      ...live,
    })
    .onConflictDoUpdate({
      target: [worktrees.projectSlug, worktrees.worktreeId],
      set: live,
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

/** Set (or, with a blank title, clear) a worktree's display title. */
export async function setWorktreeTitle(
  projectSlug: string,
  worktreeId: string,
  title: string,
): Promise<void> {
  const normalized = normalizeTitle(title)
  const db = await getDb()
  await db.update(worktrees)
    .set({ title: normalized === '' ? null : normalized })
    .where(key(projectSlug, worktreeId))
}

/** Pin (or unpin) a worktree to the sidebar's Background section. */
export async function setWorktreeBackground(
  projectSlug: string,
  worktreeId: string,
  background: boolean,
): Promise<void> {
  const db = await getDb()
  await db.update(worktrees).set({ background }).where(key(projectSlug, worktreeId))
}

/** Every row of a project, keyed by worktree id — one query per project per
 *  list build, replacing the per-session transcript parse + git config read. */
export async function getProjectWorktreeRows(
  projectSlug: string,
): Promise<Map<string, WorktreeRow>> {
  const db = await getDb()
  const rows = await db.select().from(worktrees).where(eq(worktrees.projectSlug, projectSlug))
  return new Map(rows.map((r) => [r.worktreeId, toRow(r)]))
}

/** Rows across every project (or one), for the stopped-worktree listing. */
export async function listWorktreeRows(projectSlug?: string): Promise<WorktreeRow[]> {
  const db = await getDb()
  const rows = projectSlug === undefined
    ? await db.select().from(worktrees)
    : await db.select().from(worktrees).where(eq(worktrees.projectSlug, projectSlug))
  return rows.map(toRow)
}

/**
 * Resolve a worktree by id or unique id prefix, across projects — what
 * restart uses to find a stopped worktree once its pod is gone. A prefix is matched in JS rather than as a LIKE pattern, so
 * user-supplied wildcards stay inert.
 */
export async function findWorktreeRow(idOrPrefix: string): Promise<WorktreeRow | undefined> {
  if (idOrPrefix === '') return undefined
  // Exact id is the overwhelmingly common case (the webapp and every
  // internal caller pass a full id) and answers from the index; only a
  // human-typed prefix pays for the scan.
  const db = await getDb()
  const exact = await db.select().from(worktrees)
    .where(eq(worktrees.worktreeId, idOrPrefix))
  if (exact[0]) return toRow(exact[0])
  const rows = await listWorktreeRows()
  return rows.find((r) => r.worktreeId.startsWith(idOrPrefix))
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
  }).from(worktrees).where(isNotNull(worktrees.stoppedAt))
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
    // Non-fatal: the session runs; only the sidebar's base chip is missing.
  }
}

/**
 * Worktrees recorded as live (no recorded stop) — the reaper's input for
 * spotting a row whose pod is gone. `ran` says whether the agent ever got
 * going: a captured opening message or a transcript on disk can only exist
 * if it did, which is what separates an interrupted create from a worktree
 * with history whose Job was removed out-of-band.
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
  }).from(worktrees).where(isNull(worktrees.stoppedAt))
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
