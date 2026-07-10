import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { ServerError } from '@/server/errors'
import { constantTimeEqual } from '@/server/web-auth'
import { maskToken } from '@/shared/mask'
import { tokensPath } from '@/shared/paths'

/**
 * Durable client tokens: what a remote CLI (or the auth server) presents
 * as its bearer instead of the per-boot lock secret. Named per device so
 * a single client can be revoked without touching the others. Plaintext
 * at rest, matching the lock-secret and web-sessions convention — the
 * file is 0600 under the data dir.
 */
export interface TokenEntry {
  name: string
  token: string
  createdAt: string
}

/** What `list()` exposes: never the full token. */
export interface TokenSummary {
  name: string
  masked: string
  createdAt: string
}

export interface TokenStore {
  /** Mint a token. Throws VALIDATION on a bad name, CONFLICT on a dup. */
  create(name: string): TokenEntry
  list(): TokenSummary[]
  /** Returns false when no token has that name. */
  revoke(name: string): boolean
  isValidToken(candidate: string): boolean
}

/** Device-name shape: short, filesystem/CLI-safe. */
const TOKEN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function createTokenStore(opts: {
  initialTokens?: TokenEntry[]
  onChanged?: (tokens: TokenEntry[]) => void
} = {}): TokenStore {
  const entries: TokenEntry[] = [...(opts.initialTokens ?? [])]
  const changed = (): void => opts.onChanged?.([...entries])

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
        token: crypto.randomBytes(32).toString('hex'),
        createdAt: new Date().toISOString(),
      }
      entries.push(entry)
      changed()
      return entry
    },
    list: () => entries.map((e) => ({
      name: e.name,
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
      entries.some((e) => constantTimeEqual(candidate, e.token)),
  }
}

/** Read the persisted tokens; absent or unparseable file → empty store. */
export async function loadTokens(): Promise<TokenEntry[]> {
  try {
    const raw = await fs.readFile(tokensPath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((e): e is TokenEntry =>
      !!e && typeof e === 'object'
      && typeof (e as TokenEntry).name === 'string'
      && typeof (e as TokenEntry).token === 'string'
      && typeof (e as TokenEntry).createdAt === 'string')
  } catch {
    return []
  }
}

/** Persist atomically (tmp + rename) at 0600, like the lock file. */
export async function saveTokens(tokens: TokenEntry[]): Promise<void> {
  const p = tokensPath()
  const tmp = `${p}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 })
  await fs.rename(tmp, p)
}
