import fs from 'node:fs/promises'
import { scanJsonlForward } from '#store/transcripts'

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
 * (`#runtime/status`), which holds a tmux control-mode subscription on the
 * agent pane's `#{pane_title}` — reads happen via the status store, never by
 * probing the pod. Before Claude Code sets a title the pane reports tmux's
 * default (the pod hostname), which classifies as 'waiting' — the right
 * answer for a session still booting.
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
 * Registration of yaac's agent-session discovery hook with Claude Code.
 *
 * The hook script itself is baked into the image at `/etc/yaac/agent-links.sh`
 * (dockerfiles/Dockerfile.tools) and shared with codex, which runs it as a
 * managed hook. Claude has no managed-hook tier, so it is registered from the
 * user-writable `~/.claude/settings.json` — the same file `seedClaudeSettings`
 * already owns. The script is *not* copied into the mounted claude dir: a
 * session must not be able to rewrite what yaac uses to track it.
 *
 * `SessionStart` fires on `startup`, `resume`, `clear`, and `compact`, which is
 * exactly the set of events that changes which conversation a pane is in — and
 * therefore the set yaac needs to see. `/compact` keeps the same conversation
 * id, so its firing just refreshes the same links.
 */

/** In-pod path of the shared hook script (baked into the tools image). */
export const AGENT_LINKS_HOOK = '/etc/yaac/agent-links.sh'

/** Claude's host-mounted home, as the pod sees it. */
export const CONTAINER_CLAUDE_HOME = '/home/yaac/.claude'

/** Claude's home under the project directory — the prefix a transcript path
 *  recorded by the hook carries, so the server can resolve it host-side. */
const CLAUDE_HOME_NAME = 'claude'

/** The command claude runs. The home and its project-relative name travel as
 *  arguments because one script body serves every tool (see the Dockerfile
 *  comment). */
export const CLAUDE_HOOK_COMMAND =
  `${AGENT_LINKS_HOOK} ${CONTAINER_CLAUDE_HOME} ${CLAUDE_HOME_NAME}`

interface HookEntry {
  type?: string
  command?: string
  timeout?: number
}

interface HookMatcher {
  matcher?: string
  hooks?: HookEntry[]
}

interface ClaudeSettings {
  hooks?: Record<string, HookMatcher[] | undefined>
  [key: string]: unknown
}

/**
 * Merge yaac's `SessionStart` hook into a project's `~/.claude/settings.json`.
 *
 * Idempotent and additive: unrelated settings keys (the bypass-prompt flag and
 * cleanup period `seedClaudeSettings` writes, whatever theme claude-code wrote
 * itself) and any user-registered hooks survive, and a settings file that
 * already carries our entry is left byte-identical. A malformed settings file
 * is replaced rather than propagated — claude would ignore it anyway, and the
 * two keys yaac cares about are re-seeded on every session create.
 *
 * Best-effort by contract: losing the hook costs conversation discovery for
 * that session (it falls back to the one conversation pinned by
 * `--session-id`), which must never be worth failing a session create over.
 */
export async function ensureClaudeHooks(settingsPath: string): Promise<void> {
  let settings: ClaudeSettings = {}
  try {
    settings = JSON.parse(await fs.readFile(settingsPath, 'utf8')) as ClaudeSettings
  } catch {
    // missing or invalid — start fresh
  }

  const hooks = { ...settings.hooks }
  const sessionStart = [...(hooks.SessionStart ?? [])]
  const already = sessionStart.some((m) =>
    m.hooks?.some((h) => h.command === CLAUDE_HOOK_COMMAND) ?? false,
  )
  if (already) return

  sessionStart.push({
    matcher: '*',
    hooks: [{ type: 'command', command: CLAUDE_HOOK_COMMAND, timeout: 10 }],
  })
  hooks.SessionStart = sessionStart
  settings.hooks = hooks
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n')
}
