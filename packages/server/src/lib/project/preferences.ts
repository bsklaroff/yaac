import { eq } from 'drizzle-orm'
import { getDb } from '#lib/db/client'
import { preferences, shortcutOverrides } from '#lib/db/schema'
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

/** Structural guard for a stored chord — used by the legacy JSON import,
 *  whose entries come from a file that may be hand-edited or written by an
 *  older/newer build. */
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

const VALID_TOOLS: AgentTool[] = ['claude', 'codex', 'opencode']

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
