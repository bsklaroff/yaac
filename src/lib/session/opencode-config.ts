import fs from 'node:fs/promises'
import path from 'node:path'

interface OpencodeConfig {
  permission?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * Ensures the shared opencode.json grants the websearch permission so
 * opencode's Exa-backed websearch tool is usable. Merges with any
 * existing keys rather than overwriting — opencode itself writes to
 * this file via `Config.updateGlobal()` (model selection, etc.).
 *
 * The tool is also gated on `OPENCODE_ENABLE_EXA=true` in the
 * container env; without that env var the tool isn't registered no
 * matter what the permission says.
 */
export async function ensureOpencodeConfigJson(
  opencodeConfigDir: string,
): Promise<void> {
  const configPath = path.join(opencodeConfigDir, 'opencode.json')

  let config: OpencodeConfig = {}
  try {
    const raw = await fs.readFile(configPath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      config = parsed as OpencodeConfig
    }
  } catch {
    // No existing config or invalid — start fresh
  }

  const permission: Record<string, unknown> = config.permission ?? {}
  if (permission.websearch === 'allow') return

  permission.websearch = 'allow'
  config.permission = permission
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n')
}
