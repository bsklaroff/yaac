import { eq, inArray } from 'drizzle-orm'
import { getDb } from './client'
import { preferences, shortcutOverrides } from './schema'
import { ServerError } from '@yaac/shared/errors'
import type { AgentTool } from '@yaac/shared/types'

/** A persisted keyboard-shortcut chord: a physical key `code` plus the four
 *  modifier states. Mirrors the frontend `Chord` shape (the server must not
 *  import frontend code). */
export interface SerializedChord {
  code: string
  alt: boolean
  ctrl: boolean
  meta: boolean
  shift: boolean
}

/** Structural guard for a stored chord — the shape crossing the wire from
 *  the webapp, which is not the server's to trust. */
export function isSerializedChord(value: unknown): value is SerializedChord {
  if (typeof value !== 'object' || value === null) return false
  const c = value as Record<string, unknown>
  return typeof c.code === 'string'
    && typeof c.alt === 'boolean'
    && typeof c.ctrl === 'boolean'
    && typeof c.meta === 'boolean'
    && typeof c.shift === 'boolean'
}

/** `preferences` row key for the default session tool. */
export const DEFAULT_TOOL_KEY = 'default_tool'

/** `preferences` row keys for the git identity worktrees commit under. */
export const GIT_USER_NAME_KEY = 'git_user_name'
export const GIT_USER_EMAIL_KEY = 'git_user_email'

export async function getDefaultTool(): Promise<AgentTool | undefined> {
  const db = await getDb()
  const rows = await db.select().from(preferences).where(eq(preferences.key, DEFAULT_TOOL_KEY))
  const value = rows[0]?.value
  return value !== undefined && isValidTool(value) ? value : undefined
}

export async function setDefaultTool(tool: AgentTool): Promise<void> {
  const db = await getDb()
  await db.insert(preferences)
    .values({ key: DEFAULT_TOOL_KEY, value: tool })
    .onConflictDoUpdate({ target: preferences.key, set: { value: tool } })
}

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

const VALID_TOOLS: AgentTool[] = ['claude', 'codex', 'opencode', 'pi']

export function isValidTool(value: string): value is AgentTool {
  return VALID_TOOLS.includes(value as AgentTool)
}

/**
 * Validate the incoming string and set the default tool. Throws
 * `VALIDATION` for anything that isn't a known tool name.
 */
export async function setDefaultToolChecked(toolName: string): Promise<AgentTool> {
  if (!isValidTool(toolName)) {
    throw new ServerError('VALIDATION', `Invalid tool "${toolName}". Must be one of: ${VALID_TOOLS.join(', ')}`)
  }
  await setDefaultTool(toolName)
  return toolName
}

/**
 * The git identity this server's worktrees commit under, or null when
 * either half is unset.
 *
 * A server setting rather than something read off a host, because the host
 * is not where the user is: under `k8s` the server is a pod whose `$HOME` is
 * an image layer with no git config in it, and under `containerless` the
 * host's config belongs to whoever runs the server, not to whoever is
 * driving it from another machine. Clients seed this from their own shell
 * (`seedGitIdentityFromShell`) and the webapp edits it, so both ways of
 * reaching a server can answer the question.
 *
 * Two rows rather than one JSON blob, to match every other preference here;
 * the pair is only ever read together, and half of one is no identity at all.
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
