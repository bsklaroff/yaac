import fs from 'node:fs/promises'
import readline from 'node:readline/promises'
import path from 'node:path'
import { getDataDir, ensureDataDir } from '@/lib/project/paths'
import { DaemonError } from '@/daemon/errors'
import type { AgentTool } from '@/shared/types'

/** A persisted keyboard-shortcut chord: a physical key `code` plus the four
 *  modifier states. Mirrors the frontend `Chord` shape (the daemon must not
 *  import frontend code). */
export interface SerializedChord {
  code: string
  alt: boolean
  ctrl: boolean
  meta: boolean
  shift: boolean
}

export interface PreferencesFile {
  defaultTool?: AgentTool
  /** Keyboard-shortcut overrides, keyed by command id. Only ids the user has
   *  rebound appear; the frontend overlays these on its factory defaults. */
  shortcuts?: Record<string, SerializedChord>
}

/** Structural guard for a stored chord — entries arrive from a JSON file that
 *  may be hand-edited or written by an older/newer build. */
function isSerializedChord(value: unknown): value is SerializedChord {
  if (typeof value !== 'object' || value === null) return false
  const c = value as Record<string, unknown>
  return typeof c.code === 'string'
    && typeof c.alt === 'boolean'
    && typeof c.ctrl === 'boolean'
    && typeof c.meta === 'boolean'
    && typeof c.shift === 'boolean'
}

/** Read the shortcuts map from a parsed prefs object, dropping malformed
 *  entries. */
function parseShortcuts(value: unknown): Record<string, SerializedChord> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: Record<string, SerializedChord> = {}
  for (const [id, chord] of Object.entries(value as Record<string, unknown>)) {
    if (isSerializedChord(chord)) out[id] = chord
  }
  return out
}

export function preferencesPath(): string {
  return path.join(getDataDir(), '.preferences.json')
}

export async function loadPreferences(): Promise<PreferencesFile> {
  try {
    const raw = await fs.readFile(preferencesPath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>
      const result: PreferencesFile = {}
      if (
        obj.defaultTool === 'claude'
        || obj.defaultTool === 'codex'
        || obj.defaultTool === 'opencode'
      ) {
        result.defaultTool = obj.defaultTool
      }
      const shortcuts = parseShortcuts(obj.shortcuts)
      if (Object.keys(shortcuts).length > 0) result.shortcuts = shortcuts
      return result
    }
    return {}
  } catch {
    return {}
  }
}

export async function savePreferences(prefs: PreferencesFile): Promise<void> {
  await ensureDataDir()
  await fs.writeFile(
    preferencesPath(),
    JSON.stringify(prefs, null, 2) + '\n',
  )
}

export async function getDefaultTool(): Promise<AgentTool | undefined> {
  const prefs = await loadPreferences()
  return prefs.defaultTool
}

export async function setDefaultTool(tool: AgentTool): Promise<void> {
  const prefs = await loadPreferences()
  prefs.defaultTool = tool
  await savePreferences(prefs)
}

/** All saved shortcut overrides (empty when none are set). */
export async function getShortcutOverrides(): Promise<Record<string, SerializedChord>> {
  const prefs = await loadPreferences()
  return prefs.shortcuts ?? {}
}

/** Persist a single command's rebind, leaving the other overrides intact. */
export async function setShortcutOverride(id: string, chord: SerializedChord): Promise<void> {
  const prefs = await loadPreferences()
  prefs.shortcuts = { ...prefs.shortcuts, [id]: chord }
  await savePreferences(prefs)
}

/** Drop every shortcut override, restoring the factory defaults. */
export async function clearShortcutOverrides(): Promise<void> {
  const prefs = await loadPreferences()
  delete prefs.shortcuts
  await savePreferences(prefs)
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
    throw new DaemonError('VALIDATION', `Invalid tool "${toolName}". Must be one of: ${VALID_TOOLS.join(', ')}`)
  }
  await setDefaultTool(toolName)
  return toolName
}

/**
 * Interactive prompt: ask the user to choose a default agent tool.
 */
export async function promptForDefaultTool(): Promise<AgentTool> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  console.log('Choose a default agent tool.')
  console.log('Options: claude, codex, opencode')
  const answer = (await rl.question('Default tool: ')).trim().toLowerCase()
  rl.close()
  if (!isValidTool(answer)) {
    console.error(`Invalid tool "${answer}". Must be one of: ${VALID_TOOLS.join(', ')}`)
    process.exit(1)
  }
  await setDefaultTool(answer)
  console.log(`Default tool set to "${answer}".`)
  return answer
}

/**
 * Ensure a default tool is configured.
 * If none is set, prompts the user interactively.
 */
export async function ensureDefaultTool(): Promise<AgentTool> {
  const tool = await getDefaultTool()
  if (tool) return tool
  return promptForDefaultTool()
}
