import path from 'node:path'
import { claudeDir } from '@yaac/shared/project-paths'
import { scanJsonlForward } from '#lib/session/jsonl'

/**
 * Classifies Claude Code's "actively working" state from the pane's OSC
 * terminal title. Claude Code mirrors its spinner into the title: while
 * a turn is in flight (API call, tool running, streaming response) the
 * title reads "<spinner> <task summary>" with the leading glyph cycling
 * through the Braille block (U+2800–U+28FF, the ⠋⠙⠹… animation). The
 * moment control returns to the user — idle prompt, permission dialog,
 * ExitPlanMode approval, or AskUserQuestion selector — the prefix flips
 * to "✳" (U+2733). Each of those states was verified against a live
 * session, permission dialog included; that one matters because the
 * JSONL transcript can't see UI-blocked turns (Claude Code does not
 * persist the blocking assistant tool_use until the user answers).
 *
 * Titles are pushed at the server by the session's status watcher
 * (`src/server/status-watcher.ts`), which holds a tmux control-mode
 * subscription on the agent pane's `#{pane_title}` — reads happen via
 * the status store, never by probing the pod. Before Claude Code sets
 * a title the pane reports tmux's default (the pod hostname), which
 * classifies as 'waiting' — the right answer for a session still
 * booting.
 */
const BRAILLE_SPINNER_PREFIX = /^[\u2800-\u28FF]/

export function classifyClaudeTitle(title: string): 'running' | 'waiting' {
  return BRAILLE_SPINNER_PREFIX.test(title) ? 'running' : 'waiting'
}

/**
 * Slash commands leave synthetic `type: 'user'` entries in the transcript
 * before the first real message. A `/model` invocation, for instance,
 * persists three of them: the `<local-command-caveat>` preamble (marked
 * `isMeta`), the `<command-name>…</command-name>` invocation, and its
 * `<local-command-stdout>` output. None make a sensible session title, so
 * we skip them and let the title fall through to the first real message.
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
export async function getFirstUserMessage(jsonlPath: string): Promise<string | undefined> {
  return scanJsonlForward(jsonlPath, (entry) => {
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
 * Convenience wrapper that constructs the JSONL path from project slug and session ID.
 */
export async function getSessionFirstUserMessage(projectSlug: string, sessionId: string): Promise<string | undefined> {
  const jsonlPath = path.join(claudeDir(projectSlug), 'projects', '-workspace', `${sessionId}.jsonl`)
  return getFirstUserMessage(jsonlPath)
}
