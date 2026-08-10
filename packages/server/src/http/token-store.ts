import crypto from 'node:crypto'
import { ServerError } from '@yaac/shared/errors'
import { timingSafeStrEqual } from './web-auth'
import { maskToken } from '@yaac/shared/mask'
import type { TokenEntry, TokenKind } from '#features/records'

export { loadTokens, saveTokens } from '#features/records'
export type { TokenEntry, TokenKind } from '#features/records'

/**
 * All client credentials the server hands out, in one store. Three kinds:
 *
 * - `durable` — what a remote CLI (or the auth daemon) presents as its
 *   bearer instead of the per-boot lock secret. Named per device so a
 *   single client can be revoked without touching the others.
 * - `one-time` — minted by `yaac open` (and the start banner), carried in
 *   the webapp URL. Exchange-only: never a valid bearer, consumed on its
 *   first successful exchange, expired after EXCHANGE_TTL_MS.
 * - `web` — a browser worktree, minted by the exchange and carried in the
 *   HttpOnly session cookie. Never a valid bearer either; listed and
 *   revocable like a durable token so a leaked cookie can be killed.
 *
 * Plaintext at rest, matching the lock-secret convention — persisted in
 * the server DB, whose directory is 0700 under the data dir.
 */
/** What `list()` exposes: never the full token. */
export interface TokenSummary {
  name: string
  kind: TokenKind
  masked: string
  createdAt: string
}

export interface TokenStore {
  /** Mint a durable token. Throws VALIDATION on a bad name, CONFLICT on a dup. */
  create(name: string): TokenEntry
  /** Mint a one-time exchange token (auto-named `open-…`). */
  mintExchangeToken(): TokenEntry
  /**
   * Trade a token for a fresh web session. Accepts an unexpired one-time
   * token (consumed) or a durable token (kept — it's the client's own
   * credential). Returns the new worktree's secret, or null on no match.
   */
  consumeExchange(candidate: string): string | null
  list(): TokenSummary[]
  /** Returns false when no token has that name. */
  revoke(name: string): boolean
  /** Bearer check: durable tokens only. */
  isValidToken(candidate: string): boolean
  /** Cookie check: web sessions only. */
  isValidSession(candidate: string): boolean
  /**
   * Merge persisted entries into the live store, by name; an in-memory
   * entry wins a collision. The store is built empty at boot and restored
   * from the DB only after the server lock is held, so an exchange or
   * `create` can legitimately race in first.
   */
  restoreTokens(restored: TokenEntry[]): void
}

/**
 * How long a one-time exchange token stays valid. Generous (24h) on
 * purpose: it is single-use and 256-bit, so a short TTL adds little
 * security but creates a real "URL expired before I opened the browser"
 * papercut.
 */
export const EXCHANGE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Web worktrees are minted on every exchange and never explicitly ended,
 * so cap them (oldest evicted first) to keep the persisted file bounded
 * across many `yaac open` invocations. Same bound for pending one-time
 * tokens — expiry prunes those anyway; the cap just stops a tight
 * `yaac open` loop from bloating the file within the TTL window.
 */
export const MAX_WEB_SESSIONS = 64
export const MAX_EXCHANGE_TOKENS = 64

/** Device-name shape: short, filesystem/CLI-safe. */
const TOKEN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function createTokenStore(opts: {
  initialTokens?: TokenEntry[]
  onChanged?: (tokens: TokenEntry[]) => void
  now?: () => number
} = {}): TokenStore {
  const entries: TokenEntry[] = [...(opts.initialTokens ?? [])]
  const now = opts.now ?? ((): number => Date.now())
  const changed = (): void => opts.onChanged?.([...entries])

  const pruneExpired = (): boolean => {
    const t = now()
    let dropped = false
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]
      if (e.kind === 'one-time' && e.expiresAt !== undefined && Date.parse(e.expiresAt) <= t) {
        entries.splice(i, 1)
        dropped = true
      }
    }
    return dropped
  }

  // FIFO cap per auto-minted kind: entries keeps insertion order, so the
  // first match of the kind is the oldest. Named durable tokens are never
  // evicted.
  const trim = (kind: TokenKind, max: number): void => {
    while (entries.filter((e) => e.kind === kind).length > max) {
      entries.splice(entries.findIndex((e) => e.kind === kind), 1)
    }
  }

  const autoName = (prefix: string): string => {
    while (true) {
      const name = `${prefix}-${crypto.randomBytes(4).toString('hex')}`
      if (!entries.some((e) => e.name === name)) return name
    }
  }

  const mintWebSession = (): TokenEntry => {
    const entry: TokenEntry = {
      name: autoName('web'),
      token: newToken(),
      kind: 'web',
      createdAt: new Date(now()).toISOString(),
    }
    entries.push(entry)
    trim('web', MAX_WEB_SESSIONS)
    return entry
  }

  return {
    create: (name) => {
      if (!TOKEN_NAME_RE.test(name)) {
        throw new ServerError(
          'VALIDATION',
          `invalid token name '${name}' (use letters, digits, '.', '_', '-'; max 64 chars)`,
        )
      }
      if (entries.some((e) => e.name === name)) {
        throw new ServerError('CONFLICT', `a token named '${name}' already exists — revoke it first`)
      }
      const entry: TokenEntry = {
        name,
        token: newToken(),
        kind: 'durable',
        createdAt: new Date(now()).toISOString(),
      }
      entries.push(entry)
      changed()
      return entry
    },
    mintExchangeToken: () => {
      pruneExpired()
      const t = now()
      const entry: TokenEntry = {
        name: autoName('open'),
        token: newToken(),
        kind: 'one-time',
        createdAt: new Date(t).toISOString(),
        expiresAt: new Date(t + EXCHANGE_TTL_MS).toISOString(),
      }
      entries.push(entry)
      trim('one-time', MAX_EXCHANGE_TOKENS)
      changed()
      return entry
    },
    consumeExchange: (candidate) => {
      const dropped = pruneExpired()
      const match = entries.find((e) =>
        (e.kind === 'one-time' || e.kind === 'durable') && timingSafeStrEqual(candidate, e.token))
      if (!match) {
        if (dropped) changed()
        return null
      }
      if (match.kind === 'one-time') entries.splice(entries.indexOf(match), 1)
      const session = mintWebSession()
      changed()
      return session.token
    },
    list: () => entries.map((e) => ({
      name: e.name,
      kind: e.kind,
      masked: maskToken(e.token),
      createdAt: e.createdAt,
    })),
    revoke: (name) => {
      const idx = entries.findIndex((e) => e.name === name)
      if (idx === -1) return false
      entries.splice(idx, 1)
      changed()
      return true
    },
    isValidToken: (candidate) =>
      entries.some((e) => e.kind === 'durable' && timingSafeStrEqual(candidate, e.token)),
    isValidSession: (candidate) =>
      entries.some((e) => e.kind === 'web' && timingSafeStrEqual(candidate, e.token)),
    restoreTokens: (restored) => {
      const live = new Set(entries.map((e) => e.name))
      // Prepend: restored entries predate anything minted since boot, and
      // the per-kind FIFO trim treats array order as age.
      entries.unshift(...restored.filter((e) => !live.has(e.name)))
    },
  }
}

function newToken(): string {
  return crypto.randomBytes(32).toString('hex')
}
