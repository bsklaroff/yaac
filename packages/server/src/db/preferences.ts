import { inArray } from 'drizzle-orm'
import { getDb } from './client'
import { preferences, shortcutOverrides } from './schema'

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

/** All saved shortcut overrides (empty when none are set). */
export async function getShortcutOverrides(): Promise<Record<string, SerializedChord>> {
  const db = await getDb()
  const rows = await db.select().from(shortcutOverrides)
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
export async function setShortcutOverride(id: string, chord: SerializedChord): Promise<void> {
  const db = await getDb()
  await db.insert(shortcutOverrides)
    .values({ commandId: id, ...chord })
    .onConflictDoUpdate({ target: shortcutOverrides.commandId, set: { ...chord } })
}

/** Drop every shortcut override, restoring the factory defaults. */
export async function clearShortcutOverrides(): Promise<void> {
  const db = await getDb()
  await db.delete(shortcutOverrides)
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
export async function getGitIdentity(): Promise<{ name: string; email: string } | null> {
  const db = await getDb()
  const rows = await db.select().from(preferences)
    .where(inArray(preferences.key, [GIT_USER_NAME_KEY, GIT_USER_EMAIL_KEY]))
  const byKey = new Map(rows.map((r) => [r.key, r.value]))
  const name = byKey.get(GIT_USER_NAME_KEY)?.trim()
  const email = byKey.get(GIT_USER_EMAIL_KEY)?.trim()
  if (name && email) return { name, email }
  return null
}

/** Set both halves. Validation (non-empty, email-shaped) is the caller's. */
export async function setGitIdentity(identity: { name: string; email: string }): Promise<void> {
  const db = await getDb()
  for (const [key, value] of [
    [GIT_USER_NAME_KEY, identity.name],
    [GIT_USER_EMAIL_KEY, identity.email],
  ] as const) {
    await db.insert(preferences)
      .values({ key, value })
      .onConflictDoUpdate({ target: preferences.key, set: { value } })
  }
}
