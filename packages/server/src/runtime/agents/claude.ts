import { scanJsonlForward } from './jsonl'
import type { SandboxFile } from './sandbox-fs'
import type { PermissionMode } from '@yaac/shared/types'

/**
 * Classifies Claude Code's "actively working" state from the pane's OSC
 * terminal title. Claude Code mirrors its spinner into the title: while
 * a turn is in flight (API call, tool running, streaming response) the
 * title reads "<spinner> <task summary>" with the leading glyph cycling
 * through an animation. The moment control returns to the user — idle
 * prompt, permission dialog, ExitPlanMode approval, or AskUserQuestion
 * selector — the prefix flips to "✳" (U+2733). Each of those states was
 * verified against a live session, permission dialog included; that one
 * matters because the JSONL transcript can't see UI-blocked turns (Claude
 * Code does not persist the blocking assistant tool_use until the user
 * answers).
 *
 * The title only animates because the launch command hides `$TMUX` from the
 * process (`env -u TMUX`, see `buildAgentCmd`). Claude Code checks that
 * variable to decide whether it is under a multiplexer and, as of 2.1.259,
 * pins the prefix to the idle glyph for the whole session when it is
 * (`tengu_static_title_under_mux`, on by default) — the fixtures below were
 * taken from 2.1.229, which still animated under tmux, so it landed between
 * the two — which reads as a
 * permanently `waiting` worktree, with nothing logged, failed or counted.
 * If that ever stops working, the fallbacks in descending order are: claude's
 * own record at `~/.claude/sessions/<pid>.json`, which publishes
 * `status` (busy/idle/waiting) and `waitingFor` as data rather than as
 * rendering, but is a per-*project* directory mounted into every worktree pod
 * of that project, so telling one pod's pids from another's needs a staged
 * per-pane script; or a content search over the pane, which is what opencode
 * and pi use, but claude's footer phrases are load-bearing there and at least
 * one of them ("Waiting for … to finish") also shows while the pane is idle
 * with a monitor running.
 *
 * The spinner's glyphs are NOT stable across Claude Code releases, so the
 * prefix accepts every set we have seen a release animate a title with:
 *
 *   - the Braille block (U+2800–U+28FF) — the ⠂⠐ / ⠋⠙⠹… animations
 *   - the circle phases (U+25D0–U+25D3) — the ◐◑ animation
 *
 * Both are matched as whole ranges rather than as the exact two-frame array
 * a given release ships, because the frame count has already varied within
 * a set. The idle "✳" is the invariant — it has survived every spinner
 * change — but this deliberately stays an allowlist of busy glyphs rather
 * than "idle iff ✳": an unset title is the pod hostname, and only an
 * allowlist reads that as waiting (see below) instead of running. A future
 * release that animates a third glyph set therefore fails safe — it pins a
 * working agent to `waiting` rather than a finished one to `running` — but
 * it does need a range added here.
 *
 * Titles are pushed at the server by the session's status watcher
 * (`#runtime/status`), which holds a tmux control-mode subscription on the
 * agent pane's `#{pane_title}` — reads happen via the status store, never by
 * probing the pod. Before Claude Code sets a title the pane reports tmux's
 * default (the pod hostname), which classifies as 'waiting' — the right
 * answer for a session still booting.
 */
const SPINNER_PREFIX = /^[\u2800-\u28FF\u25D0-\u25D3]/

export function classifyClaudeTitle(title: string): 'running' | 'waiting' {
  return SPINNER_PREFIX.test(title) ? 'running' : 'waiting'
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
 * claude's own names for its permission modes, as its hooks report them, read
 * back as yaac's postures. `manual` is an input alias claude reports as
 * `default`, and `dontAsk` — deny anything not pre-approved, a mode yaac never
 * launches in — reads as `manual`: nothing unapproved runs unasked.
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
