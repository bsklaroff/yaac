import { codexTranscriptFile } from '@/shared/project-paths'
import { scanJsonlForward } from '@/lib/session/jsonl'

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
