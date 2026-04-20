import fs from 'node:fs/promises'
import readline from 'node:readline/promises'
import path from 'node:path'
import { getDataDir, ensureDataDir } from '@/lib/project/paths'
import { DaemonError } from '@/lib/daemon/errors'
import type { AgentTool } from '@/types'

export interface PreferencesFile {
  defaultTool?: AgentTool
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
      if (obj.defaultTool === 'claude' || obj.defaultTool === 'codex') {
        result.defaultTool = obj.defaultTool
      }
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

const VALID_TOOLS: AgentTool[] = ['claude', 'codex']

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
  console.log('Options: claude, codex')
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
