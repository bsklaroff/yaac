import { and, eq, isNotNull, isNull, or } from 'drizzle-orm'
import { agentSessions, getDb } from '#platform/db'
import { normalizeTitle } from '@yaac/shared/titles'
import type { AgentTool, SessionDeathCause, SessionDeathReason } from '@yaac/shared/types'

/** Cap on a stored first message. Generous next to a title — the sidebar
 *  truncates for display, but the prompt also feeds title generation, which
 *  reads the opening ~1000 chars. */
export const MAX_PROMPT_LENGTH = 4000

/**
 * The session spine: one row per (project, session id) for every session
 * yaac has created. Reads that used to walk transcript directories, git
 * config, and four side tables now come from here; the cluster stays
 * authoritative for whether a session is *running*.
 *
 * Write discipline, in one line each:
 *  - `recordSessionCreated` is the only INSERT. It runs at session create
 *    and at a prewarmed spare's claim — never when a spare is warmed, so a
 *    reaped spare leaves nothing behind.
 *  - Everything else is an UPDATE, which no-ops for a row that doesn't
 *    exist. That is what keeps spares (and sessions from a foreign data
 *    dir) invisible without a single existence check.
 *  - A row is written BEFORE the session's Job, so no pod can ever be
 *    rowless — the row is what makes a pod a session, and a pod without
 *    one is invisible to every path that reads recorded state.
 *  - No *session* write deletes a row: a `deletedAt` row IS the
 *    deleted-session listing, and a restart reuses the id and clears the
 *    column. The two deletes are scoped to something other than a live
 *    session going away — `deleteProjectSessions` (the project is gone)
 *    and `deleteSessionRow` (a create that never came up, rolling back its
 *    own insert).
 *
 * `recordSessionCreated` propagates its failures: the row is what makes a
 * pod a session, so a create that can't record one has not created a
 * session and must not report success. Every other write is best-effort in
 * the same sense the old stores were — a lost title or deletion stamp
 * degrades a listing, and must never block a teardown. Reads propagate; a
 * broken DB there is a real error.
 */

/** A session row as the display paths consume it. */
export interface SessionRow {
  projectSlug: string
  sessionId: string
  tool: AgentTool
  createdAt: Date
  prompt?: string
  title?: string
  baseBranch?: string
  transcriptPath?: string
  background: boolean
  deletedAt?: Date
  deathReason?: SessionDeathReason
  deathDetail?: string
  deathSeen: boolean
}

/** Fields `recordSessionCreated` stamps on a fresh (or restarted) session. */
export interface SessionCreatedInput {
  projectSlug: string
  sessionId: string
  tool: AgentTool
  /** First user message, when the caller already knows it (an initial
   *  prompt); otherwise the capture step fills it in later. */
  prompt?: string
  /** Branch the worktree forked from. Omitted when resuming onto an
   *  existing worktree, whose recorded base is left untouched. */
  baseBranch?: string
  /** When the session came into being. Defaults to now; the startup
   *  adoption of pre-existing sessions passes the transcript's birth time
   *  instead. Never overwritten by a later re-record, so a restart doesn't
   *  reset the session's age. */
  createdAt?: Date
}

type Row = typeof agentSessions.$inferSelect

function toRow(r: Row): SessionRow {
  return {
    projectSlug: r.projectSlug,
    sessionId: r.sessionId,
    tool: r.tool as AgentTool,
    createdAt: r.createdAt,
    ...(r.prompt !== null ? { prompt: r.prompt } : {}),
    ...(r.title !== null ? { title: r.title } : {}),
    ...(r.baseBranch !== null ? { baseBranch: r.baseBranch } : {}),
    ...(r.transcriptPath !== null ? { transcriptPath: r.transcriptPath } : {}),
    background: r.background,
    ...(r.deletedAt !== null ? { deletedAt: r.deletedAt } : {}),
    ...(r.deathReason !== null ? { deathReason: r.deathReason as SessionDeathReason } : {}),
    ...(r.deathDetail !== null ? { deathDetail: r.deathDetail } : {}),
    deathSeen: r.deathSeen,
  }
}

const key = (projectSlug: string, sessionId: string) =>
  and(eq(agentSessions.projectSlug, projectSlug), eq(agentSessions.sessionId, sessionId))

/**
 * Record a session as created. Also the restart path: the id is reused, so
 * this re-stamps the live fields and clears the previous life's deletion —
 * a restarted session must not keep showing as deleted (or as having died).
 * Title and background pin are deliberately left alone; they belong to the
 * session, not to one of its lives.
 *
 * Throws on a failed write, and callers must treat that as a failed create:
 * a pod with no row is invisible to everything that reads recorded state
 * (the deleted listing, restart, titles), so handing one back would be
 * worse than failing.
 */
export async function recordSessionCreated(input: SessionCreatedInput): Promise<void> {
  const db = await getDb()
  // Capped here as well as in setSessionCapture: an initial prompt arrives
  // from the create route (10k chars) or straight from yaac-spawn (no zod
  // at all), and every stored prompt rides every snapshot.
  const prompt = input.prompt?.slice(0, MAX_PROMPT_LENGTH)
  // `createdAt` is deliberately absent here: it belongs to the session,
  // not to the life being started, so a restart keeps the original.
  const live = {
    tool: input.tool,
    deletedAt: null,
    deathReason: null,
    deathDetail: null,
    deathSeen: false,
    ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch } : {}),
  }
  await db.insert(agentSessions)
    .values({
      projectSlug: input.projectSlug,
      sessionId: input.sessionId,
      prompt: prompt ?? null,
      createdAt: input.createdAt ?? new Date(),
      ...live,
    })
    .onConflictDoUpdate({
      target: [agentSessions.projectSlug, agentSessions.sessionId],
      // A restart keeps the prompt it already captured; an explicit new
      // prompt (a fresh create reusing a dead session's id) wins.
      set: prompt !== undefined ? { prompt, ...live } : live,
    })
}

/**
 * Stamp the deletion time, plus the cause when a reaper (not the user) tore
 * the session down. Always writes the death columns so a reused id can't
 * inherit a stale cause, and resets `deathSeen` so a re-died session
 * re-flags the notification.
 */
export async function recordSessionDeleted(
  projectSlug: string,
  sessionId: string,
  cause?: SessionDeathCause,
): Promise<void> {
  try {
    const db = await getDb()
    await db.update(agentSessions).set({
      deletedAt: new Date(),
      deathReason: cause?.reason ?? null,
      deathDetail: cause?.detail ?? null,
      deathSeen: false,
    }).where(key(projectSlug, sessionId))
  } catch {
    // Non-fatal: the teardown itself is what matters.
  }
}

/** The deletion state a row carried before a restart re-stamped it live —
 *  captured so a failed restart can put it back exactly as it was. */
export interface PriorDeletion {
  deletedAt: Date
  deathReason?: SessionDeathReason
  deathDetail?: string
  deathSeen: boolean
}

/** The prior deletion of a row, if it had one. Read before a restart clears
 *  it, so the restart's rollback has something to restore. */
export function priorDeletionOf(row: SessionRow | undefined): PriorDeletion | undefined {
  if (row?.deletedAt === undefined) return undefined
  return {
    deletedAt: row.deletedAt,
    ...(row.deathReason !== undefined ? { deathReason: row.deathReason } : {}),
    ...(row.deathDetail !== undefined ? { deathDetail: row.deathDetail } : {}),
    deathSeen: row.deathSeen,
  }
}

/**
 * Put a row's deletion back the way a restart found it. Distinct from
 * `recordSessionDeleted`, which stamps a *new* deletion: that would replace
 * the recorded cause with nothing (an OOM-killed session whose restart
 * fails would forget it died of OOM) and re-raise the notification the user
 * already dismissed.
 */
export async function restoreSessionDeletion(
  projectSlug: string,
  sessionId: string,
  prior: PriorDeletion,
): Promise<void> {
  try {
    const db = await getDb()
    await db.update(agentSessions).set({
      deletedAt: prior.deletedAt,
      deathReason: prior.deathReason ?? null,
      deathDetail: prior.deathDetail ?? null,
      deathSeen: prior.deathSeen,
    }).where(key(projectSlug, sessionId))
  } catch {
    // Non-fatal: the reaper records a row whose pod never arrived.
  }
}

/** Clear a session's deletion (its id is live again after a restart). */
export async function clearSessionDeleted(projectSlug: string, sessionId: string): Promise<void> {
  try {
    const db = await getDb()
    await db.update(agentSessions).set({
      deletedAt: null,
      deathReason: null,
      deathDetail: null,
      deathSeen: false,
    }).where(key(projectSlug, sessionId))
  } catch {
    // Non-fatal — a live session is excluded from the deleted listing by
    // its pod anyway.
  }
}

/** Mark an abnormal death as seen (the user opened its detail). */
export async function recordDeathSeen(projectSlug: string, sessionId: string): Promise<void> {
  try {
    const db = await getDb()
    await db.update(agentSessions).set({ deathSeen: true }).where(key(projectSlug, sessionId))
  } catch {
    // Non-fatal — a lost write just re-shows the dot.
  }
}

/**
 * Mark every recorded abnormal death in a project seen (the user dismissed
 * the whole deleted-sessions notification at once). Scoped to rows that
 * actually died, so it can't pre-acknowledge a death that hasn't happened.
 */
export async function recordAllDeathsSeen(projectSlug: string): Promise<void> {
  try {
    const db = await getDb()
    await db.update(agentSessions).set({ deathSeen: true }).where(and(
      eq(agentSessions.projectSlug, projectSlug),
      isNotNull(agentSessions.deathReason),
    ))
  } catch {
    // Non-fatal — a lost write just re-shows the dot.
  }
}

/** Set (or, with a blank title, clear) a session's display title. */
export async function setSessionTitle(
  projectSlug: string,
  sessionId: string,
  title: string,
): Promise<void> {
  const normalized = normalizeTitle(title)
  const db = await getDb()
  await db.update(agentSessions)
    .set({ title: normalized === '' ? null : normalized })
    .where(key(projectSlug, sessionId))
}

/** Pin (or unpin) a session to the sidebar's Background section. */
export async function setSessionBackground(
  projectSlug: string,
  sessionId: string,
  background: boolean,
): Promise<void> {
  const db = await getDb()
  await db.update(agentSessions).set({ background }).where(key(projectSlug, sessionId))
}

/** Persist a captured first user message. Truncated so a pathological
 *  first message can't bloat every snapshot. */
export async function setSessionPrompt(
  projectSlug: string,
  sessionId: string,
  prompt: string,
): Promise<void> {
  await setSessionCapture(projectSlug, sessionId, { prompt })
}

/** Persist what the capture step learned. Either field may be absent — a
 *  session created with a prompt still needs its transcript path, and a
 *  transcript can exist before the agent has been prompted. */
export async function setSessionCapture(
  projectSlug: string,
  sessionId: string,
  capture: { prompt?: string | undefined; transcriptPath?: string | undefined },
): Promise<void> {
  const values = {
    ...(capture.prompt !== undefined
      ? { prompt: capture.prompt.slice(0, MAX_PROMPT_LENGTH) }
      : {}),
    ...(capture.transcriptPath !== undefined
      ? { transcriptPath: capture.transcriptPath }
      : {}),
  }
  if (Object.keys(values).length === 0) return
  try {
    const db = await getDb()
    await db.update(agentSessions).set(values).where(key(projectSlug, sessionId))
  } catch {
    // Non-fatal: the next capture pass retries.
  }
}

/** Every row of a project, keyed by session id — one query per project per
 *  list build, replacing the per-session transcript parse + git config read. */
export async function getProjectSessionRows(projectSlug: string): Promise<Map<string, SessionRow>> {
  const db = await getDb()
  const rows = await db.select().from(agentSessions).where(eq(agentSessions.projectSlug, projectSlug))
  return new Map(rows.map((r) => [r.sessionId, toRow(r)]))
}

/** Rows across every project (or one), for the deleted-session listing. */
export async function listSessionRows(projectSlug?: string): Promise<SessionRow[]> {
  const db = await getDb()
  const rows = projectSlug === undefined
    ? await db.select().from(agentSessions)
    : await db.select().from(agentSessions).where(eq(agentSessions.projectSlug, projectSlug))
  return rows.map(toRow)
}

/**
 * Resolve a session by id or unique id prefix, across projects — what
 * restart uses to find a deleted session's project and tool once its pod is
 * gone. A prefix is matched in JS rather than as a LIKE pattern, so
 * user-supplied wildcards stay inert.
 */
export async function findSessionRow(idOrPrefix: string): Promise<SessionRow | undefined> {
  if (idOrPrefix === '') return undefined
  // Exact id is the overwhelmingly common case (the webapp and every
  // internal caller pass a full id) and answers from the index; only a
  // human-typed prefix pays for the scan.
  const db = await getDb()
  const exact = await db.select().from(agentSessions)
    .where(eq(agentSessions.sessionId, idOrPrefix))
  if (exact[0]) return toRow(exact[0])
  const rows = await listSessionRows()
  return rows.find((r) => r.sessionId.startsWith(idOrPrefix))
}

/**
 * Live sessions the capture step still has work for: no first message yet,
 * or no transcript path yet. Both are needed — a session created *with* a
 * prompt (`session create -p`, yaac-spawn) has nothing to capture but still
 * needs its path stamped, or the deleted listing has nothing to stat and
 * reports its creation time as last activity forever.
 */
export async function listSessionsMissingCapture(): Promise<SessionCaptureNeed[]> {
  const db = await getDb()
  const rows = await db.select({
    projectSlug: agentSessions.projectSlug,
    sessionId: agentSessions.sessionId,
    prompt: agentSessions.prompt,
    transcriptPath: agentSessions.transcriptPath,
  }).from(agentSessions).where(and(
    isNull(agentSessions.deletedAt),
    or(isNull(agentSessions.prompt), isNull(agentSessions.transcriptPath)),
  ))
  return rows.map((r) => ({
    projectSlug: r.projectSlug,
    sessionId: r.sessionId,
    needsPrompt: r.prompt === null,
    needsTranscriptPath: r.transcriptPath === null,
  }))
}

/** What the capture step still owes one session. Both flags matter: a
 *  session created with a prompt needs only its path, and re-reading the
 *  transcript for it would replace the prompt the user actually typed with
 *  whatever the agent's log now begins with. */
export interface SessionCaptureNeed {
  projectSlug: string
  sessionId: string
  needsPrompt: boolean
  needsTranscriptPath: boolean
}

/** One session's row, or undefined. The point read the reaper and any
 *  (slug, id)-keyed caller wants — the table only grows, so `listSessionRows`
 *  is the wrong tool for asking about one session. */
export async function getSessionRow(
  projectSlug: string,
  sessionId: string,
): Promise<SessionRow | undefined> {
  const db = await getDb()
  const rows = await db.select().from(agentSessions).where(key(projectSlug, sessionId))
  return rows[0] ? toRow(rows[0]) : undefined
}

/** Session ids of a project that carry a recorded deletion — what the stale
 *  reaper needs to tell its own teardown from an out-of-band one, without
 *  loading every row (prompts included) on every tick. */
export async function listDeletedSessionIds(): Promise<Set<string>> {
  const db = await getDb()
  const rows = await db.select({
    projectSlug: agentSessions.projectSlug,
    sessionId: agentSessions.sessionId,
  }).from(agentSessions).where(isNotNull(agentSessions.deletedAt))
  return new Set(rows.map((r) => `${r.projectSlug}/${r.sessionId}`))
}

/**
 * Roll back the insert of a create that failed: the session never came up,
 * so it should leave no trace. Scoped to that — a session that ever ran is
 * recorded as deleted, never removed.
 */
export async function deleteSessionRow(projectSlug: string, sessionId: string): Promise<void> {
  const db = await getDb()
  await db.delete(agentSessions).where(key(projectSlug, sessionId))
}

/** Record the branch the worktree forked from, once provisioning resolves
 *  it. Split from the create insert so the row can exist before the Job
 *  without waiting on the (concurrent) worktree checkout. */
export async function setSessionBaseBranch(
  projectSlug: string,
  sessionId: string,
  baseBranch: string,
): Promise<void> {
  try {
    const db = await getDb()
    await db.update(agentSessions).set({ baseBranch }).where(key(projectSlug, sessionId))
  } catch {
    // Non-fatal: the session runs; only the sidebar's base chip is missing.
  }
}

/**
 * Sessions recorded as live (no recorded deletion) — the reaper's input for
 * spotting a row whose pod is gone. `ran` says whether the agent ever got
 * going: a captured prompt or a stamped transcript path can only exist if
 * it did, which is what separates an interrupted create from a session with
 * history whose Job was removed out-of-band.
 */
export async function listLiveSessionRows(): Promise<Array<{
  projectSlug: string
  sessionId: string
  ran: boolean
}>> {
  const db = await getDb()
  const rows = await db.select({
    projectSlug: agentSessions.projectSlug,
    sessionId: agentSessions.sessionId,
    prompt: agentSessions.prompt,
    transcriptPath: agentSessions.transcriptPath,
  }).from(agentSessions).where(isNull(agentSessions.deletedAt))
  return rows.map((r) => ({
    projectSlug: r.projectSlug,
    sessionId: r.sessionId,
    ran: r.prompt !== null || r.transcriptPath !== null,
  }))
}

/**
 * Forget a project's sessions. The other delete in this module, and it is
 * the project going away — not a session: `project remove` takes the
 * worktrees and transcripts with it, so leaving the rows would list
 * sessions whose restart resolves into a directory that no longer exists.
 */
export async function deleteProjectSessions(projectSlug: string): Promise<void> {
  const db = await getDb()
  await db.delete(agentSessions).where(eq(agentSessions.projectSlug, projectSlug))
}
