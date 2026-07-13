import { and, eq } from 'drizzle-orm'
import { getDb } from '#lib/db/client'
import { deletedSessions } from '#lib/db/schema'

/**
 * Records of when each session was deleted — the sort key for the
 * deleted-session view ("newest-deleted first"). A session's transcript
 * (claude/codex) or opencode meta row is what makes it *appear* deleted;
 * this store only carries the moment it happened, so the listing can order
 * by recency instead of birth time. Written on every delete path via
 * `recordSessionDeleted`; the listing falls back to transcript mtime for
 * sessions removed out-of-band that were never recorded here.
 */

/** Upsert the deletion time for a session to now. Best-effort: a failed
 *  write just means the listing falls back to mtime ordering for this row,
 *  so it never blocks teardown (mirrors saveOpencodeMeta). */
export async function recordSessionDeleted(projectSlug: string, sessionId: string): Promise<void> {
  try {
    const db = await getDb()
    await db.insert(deletedSessions)
      .values({ projectSlug, sessionId })
      .onConflictDoUpdate({
        target: [deletedSessions.projectSlug, deletedSessions.sessionId],
        set: { deletedAt: new Date() },
      })
  } catch {
    // Non-fatal: without the row the deleted listing sorts this session by
    // its transcript mtime instead of its exact deletion time.
  }
}

/** Deletion times for a project, keyed by session id. */
export async function listDeletedAt(slug: string): Promise<Map<string, Date>> {
  const db = await getDb()
  const rows = await db.select({
    sessionId: deletedSessions.sessionId,
    deletedAt: deletedSessions.deletedAt,
  }).from(deletedSessions).where(eq(deletedSessions.projectSlug, slug))
  return new Map(rows.map((r) => [r.sessionId, r.deletedAt]))
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
