import fs from 'node:fs/promises'
import path from 'node:path'
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

// ---------------------------------------------------------------------------
// Legacy hook cleanup
// ---------------------------------------------------------------------------

/**
 * Command of the SessionStart hook yaac used to seed per-session into the
 * user-writable ~/.codex/hooks.json. The transcript-discovery hook now ships
 * as a Codex *managed hook* baked into the image at /etc/codex (see
 * dockerfiles/Dockerfile.tools), which Codex trusts by policy — so nothing is
 * written into the mounted codex dir anymore.
 */
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
 * Removes the legacy yaac SessionStart hook from a project's persisted
 * ~/.codex/hooks.json (and deletes the old .yaac-hook.sh script), for projects
 * created before the managed hook existed. Left in place, that stale
 * user-layer hook would keep triggering Codex's `/hooks` trust-approval prompt
 * whenever it isn't already trusted — the exact prompt the managed hook exists
 * to avoid. Best-effort and idempotent: a project with no hooks.json (the
 * common case going forward) is a no-op.
 */
export async function removeLegacyCodexHook(codexPath: string): Promise<void> {
  await fs.rm(path.join(codexPath, '.yaac-hook.sh'), { force: true })

  const hooksJsonPath = path.join(codexPath, 'hooks.json')
  let existing: CodexHooksFile
  try {
    existing = JSON.parse(await fs.readFile(hooksJsonPath, 'utf8')) as CodexHooksFile
  } catch {
    // No hooks.json (or unreadable) — nothing to clean up.
    return
  }
  if (!existing?.hooks?.SessionStart) return

  const isYaacMatcher = (m: CodexHookMatcher): boolean =>
    m.hooks?.some((h) => h.command === YAAC_HOOK_COMMAND) ?? false
  const kept = existing.hooks.SessionStart.filter((m) => !isYaacMatcher(m))
  if (kept.length === existing.hooks.SessionStart.length) return // no yaac entry

  if (kept.length > 0) existing.hooks.SessionStart = kept
  else delete existing.hooks.SessionStart

  await fs.writeFile(hooksJsonPath, JSON.stringify(existing, null, 2) + '\n')
}
