import { and, eq } from 'drizzle-orm'
import { getDb } from '#lib/db/client'
import { sessionTitles } from '#lib/db/schema'

/**
 * Session titles, stored in the server DB keyed by (project, session).
 * Holds both user-assigned titles and model-generated ones (the
 * title-generation loop fills in untitled sessions; a user rename
 * overwrites via the same `setSessionTitle`). Titles are display-only: the
 * transcript-derived first message remains the fallback label everywhere.
 * Stored outside the container so they survive delete + restart (session
 * ids are stable across restarts).
 */

export const MAX_TITLE_LENGTH = 120

/** Normalize a user-supplied title: collapse whitespace, cap the length.
 *  Returns '' for a blank title (which clears the entry). */
export function normalizeTitle(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH)
}

export async function getSessionTitles(slug: string): Promise<Record<string, string>> {
  const db = await getDb()
  const rows = await db.select().from(sessionTitles).where(eq(sessionTitles.projectSlug, slug))
  const out: Record<string, string> = {}
  for (const row of rows) out[row.sessionId] = row.title
  return out
}

/** Set (or, with a blank title, clear) a session's title. */
export async function setSessionTitle(slug: string, sessionId: string, title: string): Promise<void> {
  const db = await getDb()
  const normalized = normalizeTitle(title)
  if (normalized === '') {
    await db.delete(sessionTitles).where(and(
      eq(sessionTitles.projectSlug, slug),
      eq(sessionTitles.sessionId, sessionId),
    ))
  } else {
    await db.insert(sessionTitles)
      .values({ projectSlug: slug, sessionId, title: normalized })
      .onConflictDoUpdate({
        target: [sessionTitles.projectSlug, sessionTitles.sessionId],
        set: { title: normalized },
      })
  }
}
