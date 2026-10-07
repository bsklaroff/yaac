import { eq } from 'drizzle-orm'
import type { AccessMode, User } from '@yaac/shared/types'
import { getDb } from './client'
import { accessModes, users } from './schema'

/*
 * The install's users and its recorded access mode (docs/remote-hosting.md
 * "Access modes"). Which mode a start may run in is decided by the
 * composition root; this module only reads and writes the rows.
 */

/** The built-in user: a `local` install's only caller, and the owner of
 *  everything an install held before it had users. The migration inserts
 *  it. */
export const BUILT_IN_USER_ID = '00000000-0000-0000-0000-000000000000'

/** How long a seen user's `lastSeenAt` may lag before it is written again. */
const LAST_SEEN_REFRESH_MS = 60 * 60_000

/** Tailnet logins already upserted this process: their user id, the name
 *  last written, and when. */
const seen = new Map<string, { id: string; name: string; at: number }>()

/** Drop the seen-user cache; the handle changed (tests switch data dirs). */
export function forgetSeenUsers(): void {
  seen.clear()
}

/**
 * The user id for a tailnet login, creating the user on first sight. The
 * row is written only when the user is new to this process, its display
 * name changed, or its `lastSeenAt` is over an hour old.
 */
export async function seeTailnetUser(login: string, name: string): Promise<string> {
  const hit = seen.get(login)
  if (hit && hit.name === name && Date.now() - hit.at < LAST_SEEN_REFRESH_MS) return hit.id
  const db = await getDb()
  const [row] = await db.insert(users).values({ login, name })
    .onConflictDoUpdate({ target: users.login, set: { name, lastSeenAt: new Date() } })
    .returning({ id: users.id })
  seen.set(login, { id: row.id, name, at: Date.now() })
  return row.id
}

/** Every user, oldest first. */
export async function listUsers(): Promise<User[]> {
  const db = await getDb()
  return db.select({ id: users.id, login: users.login, name: users.name })
    .from(users).orderBy(users.firstSeenAt)
}

/** The recorded access mode; undefined for a fresh install. */
export async function readAccessMode(): Promise<AccessMode | undefined> {
  const db = await getDb()
  const [recorded] = await db.select({ mode: accessModes.mode }).from(accessModes)
  return recorded?.mode
}

/**
 * Record the access mode, and with `owner` give the built-in user that
 * login, in one transaction. Since every row it owns references its id,
 * nothing else changes hands. A login already taken by another user is a
 * unique-constraint failure.
 */
export async function recordAccessMode(mode: AccessMode, owner?: string): Promise<void> {
  const db = await getDb()
  await db.transaction(async (tx) => {
    if (owner !== undefined) {
      await tx.update(users).set({ login: owner, name: owner }).where(eq(users.id, BUILT_IN_USER_ID))
    }
    await tx.delete(accessModes)
    await tx.insert(accessModes).values({ mode })
  })
  seen.clear()
}
