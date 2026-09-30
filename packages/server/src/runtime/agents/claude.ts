import { scanJsonlForward } from './jsonl'
import type { SandboxFile } from './sandbox-fs'
import type { PermissionMode } from '@yaac/shared/types'

/**
 * Classifies Claude Code's busy state from the pane's OSC title. During a
 * turn the title is "<spinner> <task summary>" with an animated leading
 * glyph; when control returns to the user (idle prompt, permission dialog,
 * ExitPlanMode approval, AskUserQuestion) it becomes "✳" (U+2733). The
 * permission-dialog case matters because the JSONL transcript cannot see
 * UI-blocked turns.
 *
 * The title only animates because the launch hides `$TMUX` (`env -u TMUX`,
 * see `buildAgentCmd`): since 2.1.259 claude pins the idle glyph under a
 * multiplexer, which would read as permanently `waiting`. (The fixtures
 * below come from 2.1.229.) Fallbacks if this breaks: claude's
 * `~/.claude/sessions/<pid>.json` (`status`, `waitingFor`), though that
 * directory is shared by a project's workspaces so pids need a per-pane
 * script; or a pane content search like opencode and pi use, though one
 * footer phrase ("Waiting for … to finish") also shows while idle.
 *
 * Spinner glyphs vary between releases, so every seen set is accepted as a
 * whole range:
 *
 *   - the Braille block (U+2800–U+28FF): the ⠂⠐ / ⠋⠙⠹… animations
 *   - the circle phases (U+25D0–U+25D3): the ◐◑ animation
 *
 * This is an allowlist of busy glyphs rather than "idle iff ✳" because an
 * unset title is the pod hostname, which must read as waiting. A new glyph
 * set would pin a working agent to `waiting` (the safe failure) until a
 * range is added here.
 *
 * Titles arrive via the status watcher's tmux control-mode subscription on
 * `#{pane_title}` (`#runtime/status`).
 */
const SPINNER_PREFIX = /^[\u2800-\u28FF\u25D0-\u25D3]/

export function classifyClaudeTitle(title: string): 'running' | 'waiting' {
  return SPINNER_PREFIX.test(title) ? 'running' : 'waiting'
}

/**
 * Slash commands leave synthetic `type: 'user'` entries before the first
 * real message (e.g. `/model` writes a `<local-command-caveat>` preamble,
 * the `<command-name>` invocation, and its `<local-command-stdout>`). They
 * are skipped when picking a session title.
 */
const COMMAND_WRAPPER =
  /^\s*<(?:command-name|command-message|command-args|local-command-stdout|local-command-caveat)>/

function isCommandMessage(isMeta: boolean | undefined, text: string): boolean {
  return isMeta === true || COMMAND_WRAPPER.test(text)
}

/**
 * Reads the beginning of a JSONL session log and returns the text content
 * of the first real user message — skipping slash-command and local-command
 * entries — or undefined if none is found.
 */
export async function getFirstUserMessage(file: SandboxFile): Promise<string | undefined> {
  return scanJsonlForward(file, (entry) => {
    const parsed = entry as {
      type: string
      isMeta?: boolean
      message?: { role?: string; content?: string | Array<{ type: string; text?: string }> }
    }
    if (parsed.type !== 'user') return undefined

    const content = parsed.message?.content
    let text: string | undefined
    if (typeof content === 'string') text = content
    else if (Array.isArray(content)) text = content.find((b) => b.type === 'text')?.text
    if (text === undefined) return undefined

    if (isCommandMessage(parsed.isMeta, text)) return undefined
    return text
  })
}

/**
 * claude's permission-mode names, as its hooks report them, mapped to
 * yaac's postures. claude reports `manual` as `default`; `dontAsk` (deny
 * anything not pre-approved, never launched by yaac) maps to `manual`.
 */
const CLAUDE_POSTURES: Record<string, PermissionMode> = {
  bypassPermissions: 'bypass',
  auto: 'auto',
  acceptEdits: 'accept-edits',
  plan: 'plan',
  default: 'manual',
  dontAsk: 'manual',
}

export function claudePermissionMode(reported: string): PermissionMode | undefined {
  return Object.hasOwn(CLAUDE_POSTURES, reported) ? CLAUDE_POSTURES[reported] : undefined
}
