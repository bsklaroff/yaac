import { and, eq, isNull, lt, or, sql } from 'drizzle-orm'
import { ServerError } from '@yaac/shared/errors'
import type { PermissionMode, TokenBindingKind } from '@yaac/shared/types'
import { getDb } from './client'
import { tokenBindings, users } from './schema'

/*
 * Token bindings (docs/remote-hosting.md "Token access"). Who may read,
 * make or delete one, and what a token must prove, is decided in
 * `#domain/access`; this module only reads and writes the rows.
 */

export type TokenBindingRow = typeof tokenBindings.$inferSelect

/** What a new binding stores; the rest is defaulted. */
export interface NewTokenBinding {
  owner: string
  kind: TokenBindingKind
  label: string
  ceiling: PermissionMode
  expiresAt?: Date
  tokenHash?: string
  issuer?: string
  subject?: string
  claims?: Record<string, string>
  audience?: string
}

/** A binding found for a request, with the login of the user it acts as. */
export interface ResolvedTokenBinding {
  binding: TokenBindingRow
  login: string | null
}

/** How long a used binding's `lastUsedAt` may lag before it is written again. */
const LAST_USED_REFRESH_MS = 60 * 60_000

/** One user's bindings, oldest first. */
export async function listTokenBindings(owner: string): Promise<TokenBindingRow[]> {
  const db = await getDb()
  return db.select().from(tokenBindings).where(eq(tokenBindings.owner, owner)).orderBy(tokenBindings.createdAt)
}

/** One binding by id, or undefined. */
export async function getTokenBinding(id: string): Promise<TokenBindingRow | undefined> {
  const db = await getDb()
  const [row] = await db.select().from(tokenBindings).where(eq(tokenBindings.id, id))
  return row
}

/** Store a binding; a label its owner already uses is CONFLICT. */
export async function insertTokenBinding(values: NewTokenBinding): Promise<TokenBindingRow> {
  const db = await getDb()
  const [row] = await db.insert(tokenBindings).values(values).onConflictDoNothing().returning()
  if (!row) throw new ServerError('CONFLICT', `you already have a token named "${values.label}"`)
  return row
}

/** Delete a binding; answers whether there was one. */
export async function deleteTokenBinding(id: string): Promise<boolean> {
  const db = await getDb()
  const rows = await db.delete(tokenBindings).where(eq(tokenBindings.id, id)).returning({ id: tokenBindings.id })
  return rows.length > 0
}

/** The binding holding a token hash, or an audience, with its owner's
 *  login, in one query. */
export async function findTokenBinding(by: { tokenHash: string } | { audience: string }): Promise<ResolvedTokenBinding | undefined> {
  const db = await getDb()
  const [row] = await db.select({ binding: tokenBindings, login: users.login })
    .from(tokenBindings).innerJoin(users, eq(users.id, tokenBindings.owner))
    .where('tokenHash' in by ? eq(tokenBindings.tokenHash, by.tokenHash) : eq(tokenBindings.audience, by.audience))
  return row
}

/** Note a binding's use, unless it was noted within the hour. */
export async function markTokenBindingUsed(id: string): Promise<void> {
  const db = await getDb()
  await db.update(tokenBindings).set({ lastUsedAt: new Date() }).where(and(
    eq(tokenBindings.id, id),
    or(isNull(tokenBindings.lastUsedAt), lt(tokenBindings.lastUsedAt, sql`now() - ${`${LAST_USED_REFRESH_MS} milliseconds`}::interval`)),
  ))
}

/** Record the subject a verified token carried that its binding did not
 *  expect. */
export async function recordRefusedSubject(id: string, subject: string): Promise<void> {
  const db = await getDb()
  await db.update(tokenBindings).set({ refusedSubject: subject, refusedAt: new Date() }).where(eq(tokenBindings.id, id))
}
