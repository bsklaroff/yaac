import { and, eq } from 'drizzle-orm'
import { getDb } from '#lib/db/client'
import { deletedSessions } from '#lib/db/schema'
import type { SessionDeathCause, SessionDeathReason } from '@yaac/shared/types'

/**
 * Records of when — and, for reaped sessions, why — each session was
 * deleted. `deletedAt` is the sort key for the deleted-session view
 * ("newest-deleted first"); the death columns let that view distinguish "you
 * deleted this" from "this died: out of memory". A session's transcript
 * (claude/codex) or opencode meta row is what makes it *appear* deleted;
 * this store only carries the moment (and cause) of removal. Written on
 * every delete path via `recordSessionDeleted`; the listing falls back to
 * transcript mtime for sessions removed out-of-band that were never
 * recorded here.
 */

/** Per-session row of the deleted-store: when it was removed, plus the
 *  reaper-derived cause when it died rather than being deleted, and whether
 *  the user has viewed that death's detail yet. */
export interface DeletedSessionRecord {
  deletedAt: Date
  deathReason?: SessionDeathReason
  deathDetail?: string
  seen: boolean
}

/** Upsert the deletion record for a session: `deletedAt` becomes now, and
 *  the death columns are always overwritten — `cause` when the reaper
 *  supplies one, null on a plain delete, so a reused session id can never
 *  inherit a stale cause from a previous life. `seen` resets to false on
 *  every (re-)record so a re-died reused id re-flags the notification.
 *  Best-effort: a failed write just means the listing falls back to mtime
 *  ordering for this row, so it never blocks teardown (mirrors
 *  saveOpencodeMeta). */
export async function recordSessionDeleted(
  projectSlug: string,
  sessionId: string,
  cause?: SessionDeathCause,
): Promise<void> {
  try {
    const db = await getDb()
    const deathColumns = {
      deathReason: cause?.reason ?? null,
      deathDetail: cause?.detail ?? null,
    }
    await db.insert(deletedSessions)
      .values({ projectSlug, sessionId, ...deathColumns })
      .onConflictDoUpdate({
        target: [deletedSessions.projectSlug, deletedSessions.sessionId],
        set: { deletedAt: new Date(), seen: false, ...deathColumns },
      })
  } catch {
    // Non-fatal: without the row the deleted listing sorts this session by
    // its transcript mtime instead of its exact deletion time.
  }
}

/** Mark an abnormal death as seen (the user viewed its detail in the deleted
 *  overlay). Best-effort — a lost write just re-shows the notification dot,
 *  which the next view clears again. No-op for a session with no row. */
export async function recordDeathSeen(projectSlug: string, sessionId: string): Promise<void> {
  try {
    const db = await getDb()
    await db.update(deletedSessions)
      .set({ seen: true })
      .where(and(
        eq(deletedSessions.projectSlug, projectSlug),
        eq(deletedSessions.sessionId, sessionId),
      ))
  } catch {
    // Non-fatal — see above.
  }
}

/** Deletion records for a project, keyed by session id. */
export async function listDeletedInfo(slug: string): Promise<Map<string, DeletedSessionRecord>> {
  const db = await getDb()
  const rows = await db.select({
    sessionId: deletedSessions.sessionId,
    deletedAt: deletedSessions.deletedAt,
    deathReason: deletedSessions.deathReason,
    deathDetail: deletedSessions.deathDetail,
    seen: deletedSessions.seen,
  }).from(deletedSessions).where(eq(deletedSessions.projectSlug, slug))
  return new Map(rows.map((r) => [r.sessionId, {
    deletedAt: r.deletedAt,
    deathReason: (r.deathReason ?? undefined) as SessionDeathReason | undefined,
    deathDetail: r.deathDetail ?? undefined,
    seen: r.seen,
  }]))
}

/** Drop a session's deletion record — called when its id is reused (a
 *  restart recreates the same session). Best-effort; a re-delete would
 *  overwrite the row anyway, and the active session is excluded from the
 *  deleted listing regardless, so a leftover row is harmless. */
export async function clearSessionDeleted(projectSlug: string, sessionId: string): Promise<void> {
  try {
    const db = await getDb()
    await db.delete(deletedSessions).where(and(
      eq(deletedSessions.projectSlug, projectSlug),
      eq(deletedSessions.sessionId, sessionId),
    ))
  } catch {
    // Non-fatal — see above.
  }
}
