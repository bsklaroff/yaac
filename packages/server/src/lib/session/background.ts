import { and, eq } from 'drizzle-orm'
import { getDb } from '#lib/db/client'
import { backgroundSessions } from '#lib/db/schema'

/**
 * Sessions pinned to the sidebar's "Background" section, stored in the
 * server DB keyed by (project, session). Presence of a row is the pin;
 * unpinning deletes it. Kept outside the container (like titles) so the
 * pin survives delete + restart — session ids are stable across restarts,
 * which is what lets a deleted background session keep its sidebar row.
 */

/** Pin (or unpin) a session to the Background section. Idempotent. */
export async function setSessionBackground(
  slug: string,
  sessionId: string,
  background: boolean,
): Promise<void> {
  const db = await getDb()
  if (background) {
    await db.insert(backgroundSessions)
      .values({ projectSlug: slug, sessionId })
      .onConflictDoNothing()
  } else {
    await db.delete(backgroundSessions).where(and(
      eq(backgroundSessions.projectSlug, slug),
      eq(backgroundSessions.sessionId, sessionId),
    ))
  }
}

/** Session ids pinned to Background for a project. */
export async function listBackgroundSessionIds(slug: string): Promise<Set<string>> {
  const db = await getDb()
  const rows = await db.select({ sessionId: backgroundSessions.sessionId })
    .from(backgroundSessions)
    .where(eq(backgroundSessions.projectSlug, slug))
  return new Set(rows.map((r) => r.sessionId))
}
