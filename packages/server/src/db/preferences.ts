import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from './client'
import { preferences, shortcutOverrides } from './schema'

/*
 * Per-user settings: every function takes the owning user's id.
 */

/** A persisted keyboard-shortcut chord: a physical key `code` plus the four
 *  modifier states. Mirrors the frontend `Chord`, which the server can't
 *  import. */
export interface SerializedChord {
  code: string
  alt: boolean
  ctrl: boolean
  meta: boolean
  shift: boolean
}

/** Structural guard for a chord sent by the webapp, which is untrusted. */
export function isSerializedChord(value: unknown): value is SerializedChord {
  if (typeof value !== 'object' || value === null) return false
  const c = value as Record<string, unknown>
  return typeof c.code === 'string'
    && typeof c.alt === 'boolean'
    && typeof c.ctrl === 'boolean'
    && typeof c.meta === 'boolean'
    && typeof c.shift === 'boolean'
}

/** `preferences` row keys for the git identity workspaces commit under. */
export const GIT_USER_NAME_KEY = 'git_user_name'
export const GIT_USER_EMAIL_KEY = 'git_user_email'

/** A user's saved shortcut overrides (empty when none are set). */
export async function getShortcutOverrides(owner: string): Promise<Record<string, SerializedChord>> {
  const db = await getDb()
  const rows = await db.select().from(shortcutOverrides).where(eq(shortcutOverrides.owner, owner))
  const out: Record<string, SerializedChord> = {}
  for (const row of rows) {
    out[row.commandId] = {
      code: row.code,
      alt: row.alt,
      ctrl: row.ctrl,
      meta: row.meta,
      shift: row.shift,
    }
  }
  return out
}

/** Persist a single command's rebind, leaving the other overrides intact. */
export async function setShortcutOverride(owner: string, id: string, chord: SerializedChord): Promise<void> {
  const db = await getDb()
  await db.insert(shortcutOverrides)
    .values({ owner, commandId: id, ...chord })
    .onConflictDoUpdate({ target: [shortcutOverrides.owner, shortcutOverrides.commandId], set: { ...chord } })
}

/** Drop every override of a user's, restoring the factory defaults. */
export async function clearShortcutOverrides(owner: string): Promise<void> {
  const db = await getDb()
  await db.delete(shortcutOverrides).where(eq(shortcutOverrides.owner, owner))
}

/**
 * The git identity workspaces commit under, or null when either half is
 * unset.
 *
 * Stored as a server setting rather than read from the host: under `k8s` the
 * server pod has no git config, and under `containerless` the host's config
 * belongs to whoever runs the server, not necessarily the user. The auth
 * server seeds it from the user's shell (`seedGitIdentityFromShell`); the
 * webapp and `yaac config git-identity` edit it.
 */
export async function getGitIdentity(owner: string): Promise<{ name: string; email: string } | null> {
  const db = await getDb()
  const rows = await db.select().from(preferences)
    .where(and(eq(preferences.owner, owner), inArray(preferences.key, [GIT_USER_NAME_KEY, GIT_USER_EMAIL_KEY])))
  const byKey = new Map(rows.map((r) => [r.key, r.value]))
  const name = byKey.get(GIT_USER_NAME_KEY)?.trim()
  const email = byKey.get(GIT_USER_EMAIL_KEY)?.trim()
  if (name && email) return { name, email }
  return null
}

/** Set both halves. Validation (non-empty, email-shaped) is the caller's. */
export async function setGitIdentity(owner: string, identity: { name: string; email: string }): Promise<void> {
  await setPreferences(owner, [[GIT_USER_NAME_KEY, identity.name], [GIT_USER_EMAIL_KEY, identity.email]])
}

async function setPreferences(owner: string, entries: Array<[string, string]>): Promise<void> {
  const db = await getDb()
  for (const [key, value] of entries) {
    await db.insert(preferences)
      .values({ owner, key, value })
      .onConflictDoUpdate({ target: [preferences.owner, preferences.key], set: { value } })
  }
}

const TIME_ZONE_KEY = 'time_zone'
const TIME_ZONE_PINNED_KEY = 'time_zone_pinned'

/**
 * The user's IANA time zone, which every workspace launches with as `TZ`
 * (null when no client has reported one). Clients report their device's
 * zone; `pinned` means the user chose one in settings, which device reports
 * then leave alone.
 */
export async function getTimeZone(owner: string): Promise<{ timeZone: string | null; pinned: boolean }> {
  const db = await getDb()
  const rows = await db.select().from(preferences)
    .where(and(eq(preferences.owner, owner), inArray(preferences.key, [TIME_ZONE_KEY, TIME_ZONE_PINNED_KEY])))
  const byKey = new Map(rows.map((r) => [r.key, r.value]))
  return { timeZone: byKey.get(TIME_ZONE_KEY) ?? null, pinned: byKey.get(TIME_ZONE_PINNED_KEY) === '1' }
}

/** Store the zone. Validation is the caller's. */
export async function setTimeZone(owner: string, timeZone: string, pinned: boolean): Promise<void> {
  await setPreferences(owner, [[TIME_ZONE_KEY, timeZone], [TIME_ZONE_PINNED_KEY, pinned ? '1' : '0']])
}
