import { and, eq, isNull, notExists, notInArray, or } from 'drizzle-orm'
import type { AccessMode, AdminEntry, User, UserRole } from '@yaac/shared/types'
import { getDb, type Db } from './client'
import { accessModes, projects, users } from './schema'

/*
 * The install's users, their roles and its recorded access mode
 * (docs/remote-hosting.md "Access modes", docs/multi-user.md "Roles").
 * Which mode a start may run in and who may change a role is decided above
 * this layer; this module only reads and writes the rows.
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

/** Every user, oldest first (and by login, for the several a start names at once). */
export async function listUsers(): Promise<User[]> {
  const db = await getDb()
  return db.select({ id: users.id, login: users.login, name: users.name, role: users.role })
    .from(users).orderBy(users.firstSeenAt, users.login)
}

/** One user, or undefined. */
export async function getUser(userId: string): Promise<User | undefined> {
  const db = await getDb()
  const [row] = await db.select({ id: users.id, login: users.login, name: users.name, role: users.role })
    .from(users).where(eq(users.id, userId))
  return row
}

/** The admins, oldest first, with whether each has signed in yet. */
export async function listAdmins(): Promise<AdminEntry[]> {
  const db = await getDb()
  const rows = await db.select({ login: users.login, name: users.name, lastSeenAt: users.lastSeenAt })
    .from(users).where(eq(users.role, 'admin')).orderBy(users.firstSeenAt, users.login)
  return rows.map((r) => ({ login: r.login, name: r.name, signedIn: r.lastSeenAt !== null }))
}

/**
 * Set one user's role, unless that would leave the install with no admin.
 * In one transaction, so two admins demoting each other cannot both win.
 */
export async function setUserRole(userId: string, role: UserRole): Promise<'ok' | 'last-admin'> {
  const db = await getDb()
  return db.transaction(async (tx) => {
    if (role === 'member') {
      const admins = await tx.select({ id: users.id }).from(users).where(eq(users.role, 'admin'))
      if (admins.length === 1 && admins[0].id === userId) return 'last-admin'
    }
    await tx.update(users).set({ role }).where(eq(users.id, userId))
    return 'ok'
  })
}

/**
 * Make exactly `logins` the admins: each gets a row if it has none (named
 * by its login, not yet signed in) and every other admin becomes a member,
 * the login-less built-in user included. With `expected`, refuses as
 * `stale` unless the admins' logins are exactly those right now.
 */
export async function replaceAdmins(logins: string[], expected?: string[]): Promise<'ok' | 'stale'> {
  const db = await getDb()
  const outcome = await db.transaction(async (tx) => {
    if (expected !== undefined) {
      const current = await tx.select({ login: users.login }).from(users).where(eq(users.role, 'admin'))
      const now = current.map((r) => r.login ?? '').sort()
      if (now.join('\n') !== [...expected].sort().join('\n')) return 'stale'
    }
    await writeAdmins(tx, logins)
    return 'ok'
  })
  seen.clear()
  return outcome
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/**
 * `replaceAdmins`'s write, shared with `recordAccessMode`. A revoked admin
 * who has never signed in (a mistyped login, say) is deleted rather than
 * kept as a member, unless a project was shared to them.
 */
async function writeAdmins(tx: Tx, logins: string[]): Promise<void> {
  await tx.insert(users)
    .values(logins.map((login) => ({ login, name: login, role: 'admin' as const, lastSeenAt: null })))
    .onConflictDoUpdate({ target: users.login, set: { role: 'admin' } })
  await tx.delete(users).where(and(
    eq(users.role, 'admin'),
    isNull(users.lastSeenAt),
    notInArray(users.login, logins),
    notExists(tx.select({ id: projects.id }).from(projects).where(eq(projects.owner, users.id))),
  ))
  await tx.update(users).set({ role: 'member' }).where(and(
    eq(users.role, 'admin'),
    or(isNull(users.login), notInArray(users.login, logins)),
  ))
}

/** The recorded access mode; undefined for a fresh install. */
export async function readAccessMode(): Promise<AccessMode | undefined> {
  const db = await getDb()
  const [recorded] = await db.select({ mode: accessModes.mode }).from(accessModes)
  return recorded?.mode
}

/**
 * Record the access mode, in one transaction with the admins a `tailnet`
 * start brings: `claim` gives the built-in user (already the admin) that
 * login, as a switch from `local` does, and `admins` makes exactly those
 * logins the admins (`replaceAdmins`). Since every row the built-in user
 * owns references its id, a claim changes no other hands. A login already
 * taken by another user is a unique-constraint failure.
 */
export async function recordAccessMode(
  mode: AccessMode,
  grant?: { claim: string } | { admins: string[] },
): Promise<void> {
  const db = await getDb()
  await db.transaction(async (tx) => {
    if (grant && 'claim' in grant) {
      await tx.update(users).set({ login: grant.claim, name: grant.claim }).where(eq(users.id, BUILT_IN_USER_ID))
    } else if (grant) {
      await writeAdmins(tx, grant.admins)
    }
    await tx.delete(accessModes)
    await tx.insert(accessModes).values({ mode })
  })
  seen.clear()
}
