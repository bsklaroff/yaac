import { piSessionLogs } from './transcripts'
import { scanJsonlBackward, scanJsonlForward } from './jsonl'

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

/**
 * The model pi last answered as, as `provider/model` — the same spelling pi's
 * own `--model` flag takes, so the stored value reads the way the tool talks
 * about it.
 *
 * Two entry kinds carry it and the later one wins, which is what a backward
 * scan gives for free: an assistant `message` (whose `provider`/`model` name
 * what actually answered) and a `model_change`, which pi appends when the
 * model is switched *before* anything has answered as it. Reading both is what
 * pi itself does to resolve a session's current model.
 *
 * One deliberate divergence: pi resolves along the active branch — the
 * `parentId` chain back from the current leaf — where this takes the last
 * entry in file order. They agree except right after a fork or rewind that
 * switches branch without appending, where this can name the abandoned
 * branch's model until the next answer corrects it. Reconstructing the chain
 * would mean reading the whole log, which is the walk the tail read exists to
 * avoid, and the cost of being wrong is a stale label for one turn.
 */
export async function getPiModel(jsonlPath: string): Promise<string | undefined> {
  return scanJsonlBackward(jsonlPath, (entry) => {
    const parsed = entry as {
      type?: unknown
      provider?: unknown
      modelId?: unknown
      message?: { role?: unknown; provider?: unknown; model?: unknown }
    }
    if (parsed.type === 'model_change') {
      return qualifiedModel(parsed.provider, parsed.modelId)
    }
    if (parsed.type === 'message' && parsed.message?.role === 'assistant') {
      return qualifiedModel(parsed.message.provider, parsed.message.model)
    }
    return undefined
  })
}

/** `provider/model`, or the bare model when the entry named no provider. */
function qualifiedModel(provider: unknown, model: unknown): string | undefined {
  if (typeof model !== 'string' || model.length === 0) return undefined
  return typeof provider === 'string' && provider.length > 0 ? `${provider}/${model}` : model
}
