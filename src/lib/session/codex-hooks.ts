import fs from 'node:fs/promises'
import path from 'node:path'
import * as TOML from 'smol-toml'

const YAAC_HOOK_COMMAND = '/home/yaac/.codex/.yaac-hook.sh'

interface CodexHookEntry {
  type: string
  command: string
  timeout?: number
  statusMessage?: string
}

interface CodexHookMatcher {
  matcher: string
  hooks: CodexHookEntry[]
}

interface CodexHooksFile {
  hooks: Record<string, CodexHookMatcher[]>
}

/**
 * Ensures the codex hooks.json contains our SessionStart hook, merging
 * with any existing user-defined hooks rather than overwriting them.
 */
export async function ensureCodexHooksJson(codexPath: string): Promise<void> {
  const hooksJsonPath = path.join(codexPath, 'hooks.json')

  let existing: CodexHooksFile = { hooks: {} }
  try {
    const raw = await fs.readFile(hooksJsonPath, 'utf8')
    existing = JSON.parse(raw) as CodexHooksFile
  } catch {
    // No existing hooks.json or invalid — start fresh
  }

  if (!existing.hooks) existing.hooks = {}
  if (!existing.hooks.SessionStart) existing.hooks.SessionStart = []

  // Check if our hook is already present
  const hasYaacHook = existing.hooks.SessionStart.some((m) =>
    m.hooks?.some((h) => h.command === YAAC_HOOK_COMMAND),
  )

  if (!hasYaacHook) {
    existing.hooks.SessionStart.push({
      matcher: '*',
      hooks: [{
        type: 'command',
        command: YAAC_HOOK_COMMAND,
        timeout: 10,
      }],
    })
  }

  await fs.writeFile(hooksJsonPath, JSON.stringify(existing, null, 2) + '\n')
}

/**
 * Ensures the codex config.toml has codex_hooks enabled under [features],
 * merging with any existing configuration rather than overwriting it.
 */
export async function ensureCodexConfigToml(codexPath: string): Promise<void> {
  const configPath = path.join(codexPath, 'config.toml')

  let config: Record<string, unknown> = {}
  try {
    const raw = await fs.readFile(configPath, 'utf8')
    config = TOML.parse(raw) as Record<string, unknown>
  } catch {
    // No existing config or invalid — start fresh
  }

  const features = (config.features ?? {}) as Record<string, unknown>
  if (features.codex_hooks === true) return

  features.codex_hooks = true
  config.features = features
  await fs.writeFile(configPath, TOML.stringify(config))
}
