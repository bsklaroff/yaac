import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { getDataDir } from '@/shared/paths'

/**
 * Session share invites. An invite is a capability token scoped to one
 * session: anyone presenting it (via /join) gets a guest cookie limited to
 * viewing — or, in 'drive' mode, typing into — that session's agent
 * terminal. Multi-use until expiry or revocation (it's a link, not a
 * one-time code); persisted so links survive daemon restarts.
 */

export type InviteMode = 'view' | 'drive'

export interface SessionInvite {
  token: string
  sessionId: string
  mode: InviteMode
  /** Epoch ms. */
  createdAt: number
  /** Epoch ms. */
  expiresAt: number
}

export const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export function invitesPath(): string {
  return path.join(getDataDir(), '.session-invites.json')
}

function isInvite(v: unknown): v is SessionInvite {
  if (!v || typeof v !== 'object') return false
  const i = v as Record<string, unknown>
  return typeof i.token === 'string' && i.token.length >= 32
    && typeof i.sessionId === 'string' && i.sessionId.length > 0
    && (i.mode === 'view' || i.mode === 'drive')
    && typeof i.createdAt === 'number'
    && typeof i.expiresAt === 'number'
}

async function readAll(): Promise<SessionInvite[]> {
  try {
    const raw = await fs.readFile(invitesPath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isInvite)
  } catch {
    return []
  }
}

async function writeAll(invites: SessionInvite[]): Promise<void> {
  await fs.writeFile(invitesPath(), JSON.stringify(invites, null, 2) + '\n', { mode: 0o600 })
}

/** Mint an invite for a session. */
export async function createInvite(
  sessionId: string,
  mode: InviteMode,
  opts: { ttlMs?: number; now?: number } = {},
): Promise<SessionInvite> {
  const now = opts.now ?? Date.now()
  const invite: SessionInvite = {
    token: crypto.randomBytes(32).toString('hex'),
    sessionId,
    mode,
    createdAt: now,
    expiresAt: now + (opts.ttlMs ?? DEFAULT_INVITE_TTL_MS),
  }
  const all = await readAll()
  all.push(invite)
  await writeAll(all)
  return invite
}

/** Invites for one session (or all), expired ones pruned from the file. */
export async function listInvites(sessionId?: string, now = Date.now()): Promise<SessionInvite[]> {
  const all = await readAll()
  const live = all.filter((i) => i.expiresAt > now)
  if (live.length !== all.length) await writeAll(live)
  return sessionId ? live.filter((i) => i.sessionId === sessionId) : live
}

/** The invite for `token` if it exists and hasn't expired. */
export async function getValidInvite(token: string, now = Date.now()): Promise<SessionInvite | null> {
  const all = await readAll()
  const match = all.find((i) => i.token === token)
  return match && match.expiresAt > now ? match : null
}

/** Revoke an invite. Guests holding cookies minted from it lose access on
 *  their next request (scope is resolved against the invite live). */
export async function revokeInvite(token: string): Promise<void> {
  const all = await readAll()
  const remaining = all.filter((i) => i.token !== token)
  if (remaining.length !== all.length) await writeAll(remaining)
}
