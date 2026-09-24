import { scanJsonlBackward, scanJsonlForward } from './jsonl'
import type { PermissionMode } from '@yaac/shared/types'

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
 * server by the session's status watcher (`#runtime/status`)
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
 * The model codex last ran a turn with, from the newest `turn_context` entry.
 *
 * codex records a `turn_context` at every turn boundary carrying that turn's
 * settings — model, approval policy, sandbox, effort — so the last one is
 * both the current model and what the next turn will use. The messages
 * themselves name no model, which is why this reads turn boundaries rather
 * than answers (verified against the rollout codex 0.142.4 writes:
 * `{"type":"turn_context","payload":{"model":"gpt-5.6-sol",…}}`).
 */
export async function getCodexModel(jsonlPath: string): Promise<string | undefined> {
  return scanJsonlBackward(jsonlPath, (entry) => {
    const parsed = entry as { type?: unknown; payload?: { model?: unknown } }
    if (parsed.type !== 'turn_context') return undefined
    const model = parsed.payload?.model
    return typeof model === 'string' && model.length > 0 ? model : undefined
  })
}

/** The settings codex records for a thread, as far as a posture goes. */
interface CodexThreadSettings {
  approval_policy?: unknown
  approvals_reviewer?: unknown
  permission_profile?: { type?: unknown; file_system?: { entries?: unknown } }
  collaboration_mode?: { mode?: unknown }
}

/**
 * The posture codex is running under, from the newest settings its rollout
 * records — or undefined when the rollout names none, or names settings no
 * posture stands for.
 *
 * Two entries carry them, and the newer wins. A `turn_context` is written at
 * every turn boundary, and a `thread_settings_applied` event the moment the
 * user changes something mid-session (`/permissions`, Shift+Tab into plan
 * mode) — so a change lands here within a second or two, not a turn later.
 * Both carry the approval policy, who reviews approvals, the permission
 * profile and the collaboration mode (verified against codex-cli 0.156.1).
 *
 * The profile is read rather than `sandbox_policy`, because only
 * `turn_context` has the latter: `disabled` is full access, and a managed one
 * is workspace-write when it grants a write anywhere and read-only when it
 * grants none. That inverts the launch table in `buildAgentCmd`, plus codex's
 * own plan mode, which is what the user asked for by entering it.
 */
export async function getCodexPermissionMode(jsonlPath: string): Promise<PermissionMode | undefined> {
  return scanJsonlBackward(jsonlPath, (entry) => {
    const parsed = entry as {
      type?: unknown
      payload?: CodexThreadSettings & { type?: unknown; thread_settings?: CodexThreadSettings }
    }
    const settings = parsed.type === 'turn_context'
      ? parsed.payload
      : parsed.type === 'event_msg' && parsed.payload?.type === 'thread_settings_applied'
        ? parsed.payload.thread_settings
        : undefined
    // `null` stops the scan: the newest settings are the answer even when
    // they name no posture, rather than an older entry that did.
    return settings === undefined ? undefined : codexPosture(settings) ?? null
  }).then((mode) => mode ?? undefined)
}

function codexPosture(s: CodexThreadSettings): PermissionMode | undefined {
  if (s.collaboration_mode?.mode === 'plan') return 'plan'
  const profile = s.permission_profile
  const entries = Array.isArray(profile?.file_system?.entries) ? profile.file_system.entries : []
  const sandbox = profile?.type === 'disabled'
    ? 'full'
    : profile?.type !== 'managed'
      ? undefined
      : entries.some((e) => (e as { access?: unknown } | null)?.access === 'write') ? 'workspace' : 'read-only'
  const reviewer = s.approvals_reviewer ?? 'user'
  if (s.approval_policy === 'never' && sandbox === 'full') return 'bypass'
  if (s.approval_policy === 'untrusted' && sandbox === 'workspace') return 'manual'
  if (s.approval_policy !== 'on-request') return undefined
  if (sandbox === 'read-only' && reviewer === 'user') return 'plan'
  if (sandbox !== 'workspace') return undefined
  if (reviewer === 'auto_review') return 'auto'
  return reviewer === 'user' ? 'accept-edits' : undefined
}
