import fs from 'node:fs/promises'
import { scanJsonlForward } from './jsonl'

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
 * The hook script itself is `worktree-bin/yaac-agent-links`, staged per
 * worktree and put on the workspace's PATH by whichever driver is running it
 * (a read-only File mount at `/usr/local/bin` under k8s, a symlink in the
 * workspace's bin dir under containerless). It is shared with codex, which
 * runs it as a managed hook; claude has no managed-hook tier, so it is
 * registered from the user-writable `~/.claude/settings.json` — the same file
 * `seedClaudeSettings` already owns.
 *
 * The command names the script by BARE NAME and the home through `$HOME`,
 * because no absolute form of either is right under both drivers: the staged
 * script lives at `/usr/local/bin` in a pod and under the workspace's private
 * home on a host, and this settings file is shared by a whole project — the
 * same bytes are read by worktrees of either kind. Hooks run through
 * `/bin/sh -c` with the agent's environment, which is what makes both resolve.
 *
 * The cost of the bare name is that discovery now depends on the staging dir
 * being on the workspace's PATH — `/usr/local/bin` in an image, which a user
 * Dockerfile resetting `ENV PATH` would drop, silently costing that project
 * conversation discovery. `yaac-spawn` already rests on the same assumption,
 * and the alternative (an absolute path) is what could not be written at all.
 *
 * The script is deliberately not copied into the mounted claude dir, which a
 * session can rewrite. That is a tidiness boundary rather than a security one:
 * an agent that wanted to forge discovery data can already append to the
 * session-starts log itself, which is mounted writable beside it.
 *
 * `SessionStart` fires on `startup`, `resume`, `clear`, and `compact`, which is
 * exactly the set of events that changes which conversation a pane is in — and
 * therefore the set yaac needs to see. `/compact` keeps the same conversation
 * id, so its firing just refreshes the same links.
 */

/** Claude's home under the project directory — the prefix a transcript path
 *  recorded by the hook carries, so the server can resolve it host-side. It is
 *  also the tail of the workspace-side home, which is why one `$HOME`-relative
 *  form serves both drivers. */
const CLAUDE_HOME_NAME = 'claude'

/** The command claude runs. The home and its project-relative name travel as
 *  arguments because one script body serves every tool (see the script). */
export const CLAUDE_HOOK_COMMAND =
  `yaac-agent-links "$HOME/.${CLAUDE_HOME_NAME}" ${CLAUDE_HOME_NAME}`

/** Commands written by installs that registered the hook by its in-image path,
 *  before it became a staged worktree-bin script. Matched by prefix so any
 *  argument variant is caught. See docs/legacy-compat-shims.md. */
const LEGACY_HOOK_PREFIX = '/etc/yaac/agent-links.sh'

/** Distinguishes the temp files of concurrent writes within one process. */
let tmpSeq = 0

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
 * Also strips the pre-worktree-bin form of our own hook, which named the
 * script by its in-image path. That command is dead under both drivers now,
 * and left in place it errors on every session start.
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
  let stripped = false
  const sessionStart: HookMatcher[] = []
  for (const matcher of hooks.SessionStart ?? []) {
    if (matcher.hooks === undefined) {
      sessionStart.push(matcher)
      continue
    }
    const kept = matcher.hooks.filter((h) => !h.command?.startsWith(LEGACY_HOOK_PREFIX))
    if (kept.length === matcher.hooks.length) {
      sessionStart.push(matcher)
      continue
    }
    stripped = true
    // A matcher whose every hook was ours has nothing left to match on.
    if (kept.length > 0) sessionStart.push({ ...matcher, hooks: kept })
  }
  const already = sessionStart.some((m) =>
    m.hooks?.some((h) => h.command === CLAUDE_HOOK_COMMAND) ?? false,
  )
  if (already && !stripped) return

  if (!already) {
    sessionStart.push({
      matcher: '*',
      hooks: [{ type: 'command', command: CLAUDE_HOOK_COMMAND, timeout: 10 }],
    })
  }
  hooks.SessionStart = sessionStart
  settings.hooks = hooks

  // Written through a temp file in the same directory and renamed, because
  // this file has other writers — the user edits it by hand, and claude
  // rewrites it itself when a theme changes. A plain write truncates first,
  // and a reader landing in that window sees invalid JSON; our own answer to
  // invalid JSON is "start fresh", so a torn read compounds into silently
  // discarding the user's settings and their own hooks on the next create.
  // Same directory so the rename stays on one filesystem, and hence atomic.
  // The name is unique per call as well as per process: two creates in the
  // same project run concurrently, and a shared temp name would let one
  // rename the other's half-written file into place.
  const tmp = `${settingsPath}.${String(process.pid)}.${String(tmpSeq++)}.tmp`
  await fs.writeFile(tmp, JSON.stringify(settings, null, 2) + '\n')
  try {
    await fs.rename(tmp, settingsPath)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}
