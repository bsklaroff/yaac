import fs from 'node:fs/promises'
import path from 'node:path'
import * as TOML from 'smol-toml'
import { codexTranscriptFile } from '@yaac/shared/project-paths'
import { scanJsonlForward } from '#features/sessions/jsonl'

// ---------------------------------------------------------------------------
// Status + first-message
// ---------------------------------------------------------------------------

interface CodexEntry {
  type: string
  payload?: {
    type?: string
    message?: string
  }
}

function getUserMessageText(entry: CodexEntry): string | undefined {
  if (entry.payload?.type === 'user_message' && typeof entry.payload.message === 'string' && entry.payload.message.length > 0) {
    return entry.payload.message
  }
  return undefined
}

/**
 * Classifies Codex's "actively working" state from the pane's OSC
 * terminal title, mirroring claude-status.ts. Titles are pushed at the
 * server by the session's status watcher (`src/server/status-watcher.ts`)
 * via a tmux control-mode subscription; reads happen via the status
 * store, never by probing the pod. Codex's default terminal title is
 * built from the `[tui].terminal_title` items `["activity",
 * "project-name"]`: while a task is running the activity item renders a
 * Braille spinner frame (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏, all inside U+2800–U+28FF) ahead of
 * the project name, and the moment the turn ends the title drops back to
 * the bare project name. When Codex blocks on user input (an approval
 * prompt) the spinner is suppressed entirely and the title instead gains
 * a blinking "[ ! ] Action Required" prefix — so the leading-Braille test
 * classifies every user-blocked state as 'waiting', which is exactly what
 * the JSONL transcript could not reliably tell us (verified against
 * codex-cli 0.142.4: codex-rs/tui/src/chatwidget/status_surfaces.rs, and
 * live — a turn in flight cycles all ten spinner frames in the title).
 *
 * Before Codex sets a title the pane reports tmux's default (the pod
 * hostname), which classifies as 'waiting' — the right answer for a
 * session still booting.
 */
const BRAILLE_SPINNER_PREFIX = /^[\u2800-\u28FF]/

export function classifyCodexTitle(title: string): 'running' | 'waiting' {
  return BRAILLE_SPINNER_PREFIX.test(title) ? 'running' : 'waiting'
}

/**
 * Reads the beginning of a Codex JSONL session log and returns the text of
 * the first user message, or undefined if none is found.
 */
export async function getCodexFirstUserMessage(jsonlPath: string): Promise<string | undefined> {
  return scanJsonlForward(jsonlPath, (entry) => getUserMessageText(entry as CodexEntry))
}

/**
 * Convenience wrapper that reads the transcript via the symlink at
 * .yaac-transcripts/{sessionId}.jsonl inside the codex dir.
 */
export async function getSessionCodexFirstUserMessage(projectSlug: string, sessionId: string): Promise<string | undefined> {
  return getCodexFirstUserMessage(codexTranscriptFile(projectSlug, sessionId))
}

// ---------------------------------------------------------------------------
// Hooks + config seeding
// ---------------------------------------------------------------------------

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
 * Ensures the codex config.toml has the settings we need, merging with any
 * existing configuration rather than overwriting it.
 *
 * - check_for_update_on_startup = false: skips codex's startup update probe
 *   against api.github.com so a fresh pod drops straight to the agent input
 *   instead of stalling on (or prompting about) a version check. This matters
 *   for yaac-spawn, which expects an unattended session to reach the prompt.
 * - [features] codex_hooks = true: enables the hooks we install via hooks.json
 * - [features] apps = false: disables the codex_apps MCP server, which fails to
 *   handshake against chatgpt.com/backend-api/wham/apps and surfaces a
 *   startup warning on every session.
 *   See https://github.com/openai/codex/issues/16550
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
  if (
    config.check_for_update_on_startup === false &&
    features.codex_hooks === true &&
    features.apps === false
  ) {
    return
  }

  config.check_for_update_on_startup = false
  features.codex_hooks = true
  features.apps = false
  config.features = features
  await fs.writeFile(configPath, TOML.stringify(config))
}
