import { getDb } from './client'
import { tokens as tokensTable } from './schema'

/**
 * The persisted half of the HTTP token store (`#http`): the rows that let
 * durable tokens and web sessions survive a restart. The in-memory store
 * stays the live source of record; these two are its load-on-boot and
 * write-behind.
 */
export type TokenKind = 'durable' | 'one-time' | 'web'

export interface TokenEntry {
  name: string
  token: string
  kind: TokenKind
  createdAt: string
  /** Only on `one-time` entries: past this instant the token is dead. */
  expiresAt?: string
}

/**
 * Read the persisted tokens from the DB. Ordered by (createdAt, name) —
 * deterministic and chronologically correct for the per-kind FIFO trim
 * except same-millisecond ties, where either eviction choice is harmless.
 */
export async function loadTokens(): Promise<TokenEntry[]> {
  const db = await getDb()
  const rows = await db.select().from(tokensTable)
    .orderBy(tokensTable.createdAt, tokensTable.name)
  return rows.map((row) => ({
    name: row.name,
    token: row.token,
    kind: row.kind as TokenKind,
    createdAt: row.createdAt,
    ...(row.expiresAt === null ? {} : { expiresAt: row.expiresAt }),
  }))
}

/** Persist the full set — a transactional DELETE-all + INSERT, the DB port
 *  of the old whole-file rewrite. The in-memory `entries` array stays the
 *  live store of record. */
export async function saveTokens(tokens: TokenEntry[]): Promise<void> {
  const db = await getDb()
  await db.transaction(async (tx) => {
    await tx.delete(tokensTable)
    if (tokens.length > 0) {
      await tx.insert(tokensTable).values(tokens.map((e) => ({
        name: e.name,
        token: e.token,
        kind: e.kind,
        createdAt: e.createdAt,
        expiresAt: e.expiresAt ?? null,
      })))
    }
  })
}
