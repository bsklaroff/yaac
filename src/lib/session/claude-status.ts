import path from 'node:path'
import { claudeDir } from '@/lib/project/paths'
import { scanJsonlForward } from '@/lib/session/jsonl'

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
 * Titles are pushed at the daemon by the session's status watcher
 * (`src/daemon/status-watcher.ts`), which holds a tmux control-mode
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
 * Reads the beginning of a JSONL session log and returns the text content
 * of the first user message, or undefined if none is found.
 */
export async function getFirstUserMessage(jsonlPath: string): Promise<string | undefined> {
  return scanJsonlForward(jsonlPath, (entry) => {
    const parsed = entry as {
      type: string
      message?: { role?: string; content?: string | Array<{ type: string; text?: string }> }
    }
    if (parsed.type !== 'user') return undefined

    const content = parsed.message?.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      const textBlock = content.find((b) => b.type === 'text')
      if (textBlock?.text) return textBlock.text
    }
    return undefined
  })
}

/**
 * Convenience wrapper that constructs the JSONL path from project slug and session ID.
 */
export async function getSessionFirstUserMessage(projectSlug: string, sessionId: string): Promise<string | undefined> {
  const jsonlPath = path.join(claudeDir(projectSlug), 'projects', '-workspace', `${sessionId}.jsonl`)
  return getFirstUserMessage(jsonlPath)
}
