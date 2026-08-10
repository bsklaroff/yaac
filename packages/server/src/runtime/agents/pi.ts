import { piSessionLogs } from '#store/transcripts'
import { scanJsonlForward } from '#store/transcripts'

/**
 * Status classification + first-message lookup for pi (earendil) sessions.
 *
 * Unlike opencode, pi writes plain JSONL session logs (one
 * `<timestamp>_<worktreeId>.jsonl` per session) into the shared, host-mounted
 * `.pi` home (`piSessionsDir`), so the first-message lookup reads those files
 * directly on the host — no HTTP probe and no DB meta cache. A session's logs
 * are matched by the id pi embeds in the filename (from our `--session-id`).
 * The files persist across container teardown, so the live and deleted-session
 * lookups are the same read.
 *
 * Status is read from the rendered tmux pane (window `yaac:pi.0`). The busy/idle
 * classification runs *inside tmux*: the session's status watcher
 * (`#runtime/status`) subscribes to a format built from
 * `PI_BUSY_MARKERS`, so only the resolved word crosses the control-mode stream
 * — the rendered pane never does, the same path opencode uses.
 */

/**
 * Busy markers for a pi pane, as tmux ERE patterns (see `busyStatusFormat` in
 * status-watcher.ts). Any match in the visible pane means `running`; none means
 * `waiting` (a still-booting pane, or one sitting at the prompt).
 *
 * pi does not document a busy/idle terminal-title signal, so we read the
 * rendered pane: while a turn is in flight pi shows an interrupt hint
 * ("esc to interrupt" / "esc to cancel") and/or a "working"/"thinking" status.
 *
 * tmux-ERE constraints (matched case-insensitively via `#{C/ri:}`): use `(...)`
 * not `(?:...)`, no `{n,}` intervals. NOTE: the exact markers are validated
 * against a live pi session — refine these patterns if pi's footer wording
 * differs.
 */
export const PI_BUSY_MARKERS: readonly string[] = [
  'esc\\s+(to\\s+)?(interrupt|cancel|stop)',
  '\\b(thinking|working|generating|streaming|running)\\b',
]

interface PiMessageEntry {
  type?: unknown
  message?: { role?: unknown; content?: unknown }
}

/** Extract text from a pi `role:"user"` message entry (string or content parts). */
function getUserMessageText(entry: PiMessageEntry): string | undefined {
  if (entry.type !== 'message') return undefined
  const msg = entry.message
  if (!msg || typeof msg !== 'object' || msg.role !== 'user') return undefined
  const content = msg.content
  if (typeof content === 'string') return content.length > 0 ? content : undefined
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (part && typeof part === 'object') {
          const p = part as Record<string, unknown>
          if (p.type === 'text' && typeof p.text === 'string') return p.text
        }
        return ''
      })
      .join('')
      .trim()
    return text.length > 0 ? text : undefined
  }
  return undefined
}

/**
 * First user message for a pi session, used by `yaac worktree list` to show a
 * prompt preview. Reads the oldest session log's first `role:"user"` entry;
 * falls through to later logs if the first has none (e.g. an empty session).
 * Host files persist across teardown, so this serves live and deleted
 * sessions alike.
 */
export async function getSessionPiFirstUserMessage(
  projectSlug: string,
  worktreeId: string,
): Promise<string | undefined> {
  const files = await piSessionLogs(projectSlug, worktreeId)
  for (const file of files) {
    const msg = await getPiFirstUserMessage(file)
    if (msg !== undefined) return msg
  }
  return undefined
}

/** One pi log's first user message. Path-based, for a conversation the link
 *  tree already resolved to a file. */
export async function getPiFirstUserMessage(jsonlPath: string): Promise<string | undefined> {
  return scanJsonlForward(jsonlPath, (entry) => getUserMessageText(entry as PiMessageEntry))
}
