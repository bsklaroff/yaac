import { scanJsonlForward } from './jsonl'
import type { SandboxFile } from './sandbox-fs'

/**
 * Status classification and first-message lookup for pi.
 *
 * pi writes plain JSONL logs (`<timestamp>_<sessionId>.jsonl`) into the
 * workspace's history, read directly from the host and matched by the id
 * from our `--session-id` (see `transcripts.ts`). They persist after the
 * workspace stops, so live and stopped lookups are the same read.
 *
 * Status is classified inside tmux, as for opencode, from `PI_BUSY_MARKERS`.
 */

/**
 * Busy markers for a pi pane, as tmux EREs (see `busyStatusFormat` in
 * agent-tools.ts). A match means `running`, none means `waiting`.
 *
 * pi has no documented busy title, so these match what it renders during a
 * turn: an interrupt hint ("esc to interrupt" / "esc to cancel") and/or a
 * "working"/"thinking" status. Refine them if pi's footer wording changes.
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

/** One pi log's first user message, for a conversation already resolved
 *  to a file. */
export async function getPiFirstUserMessage(file: SandboxFile): Promise<string | undefined> {
  return scanJsonlForward(file, (entry) => getUserMessageText(entry as PiMessageEntry))
}
