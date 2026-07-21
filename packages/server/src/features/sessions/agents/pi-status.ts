import fs from 'node:fs/promises'
import path from 'node:path'
import type { Dirent } from 'node:fs'
import { piSessionsDir } from '@yaac/shared/project-paths'
import { scanJsonlForward } from '#features/sessions/jsonl'

/**
 * Status classification + first-message lookup for pi (earendil) sessions.
 *
 * Unlike opencode, pi writes plain JSONL session logs (one
 * `<timestamp>_<sessionId>.jsonl` per session) into the shared, host-mounted
 * `.pi` home (`piSessionsDir`), so the first-message lookup reads those files
 * directly on the host — no HTTP probe and no DB meta cache. A session's logs
 * are matched by the id pi embeds in the filename (from our `--session-id`).
 * The files persist across container teardown, so the live and deleted-session
 * lookups are the same read.
 *
 * Status is read from the rendered tmux pane (window `yaac:pi.0`). The busy/idle
 * classification runs *inside tmux*: the session's status watcher
 * (`src/server/status-watcher.ts`) subscribes to a format built from
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
 * Collect pi's JSONL session logs under `dir`, sorted chronologically. pi
 * names files `<timestamp>_<uuid>.jsonl` and may nest them under a
 * cwd-derived subdir, so walk one level of subdirectories too. The timestamp
 * prefix sorts chronologically, so a lexical basename sort matches session
 * order (mtime would drift as pi appends).
 */
async function listPiJsonlFiles(dir: string): Promise<string[]> {
  const found: string[] = []
  async function walk(d: string, depth: number): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await fs.readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(d, e.name)
      if (e.isFile() && e.name.endsWith('.jsonl')) found.push(full)
      else if (e.isDirectory() && depth > 0) await walk(full, depth - 1)
    }
  }
  await walk(dir, 1)
  return found.sort((a, b) => path.basename(a).localeCompare(path.basename(b)))
}

/**
 * The session id embedded in a pi log filename. pi names each log
 * `<timestamp>_<sessionId>.jsonl` (we pass our session id via `--session-id`);
 * the timestamp prefix carries no underscore, so the id is everything after
 * the first one. Returns undefined for a name without that separator.
 */
function sessionIdFromPiLog(file: string): string | undefined {
  const base = path.basename(file, '.jsonl')
  const sep = base.indexOf('_')
  if (sep < 0) return undefined
  const id = base.slice(sep + 1)
  return id.length > 0 ? id : undefined
}

/** A session's pi logs (oldest first), matched by id within the shared home. */
async function piLogsForSession(projectSlug: string, sessionId: string): Promise<string[]> {
  const files = await listPiJsonlFiles(piSessionsDir(projectSlug))
  return files.filter((f) => sessionIdFromPiLog(f) === sessionId)
}

/**
 * First user message for a pi session, used by `yaac session list` to show a
 * prompt preview. Reads the oldest session log's first `role:"user"` entry;
 * falls through to later logs if the first has none (e.g. an empty session).
 * Host files persist across teardown, so this serves live and deleted
 * sessions alike.
 */
export async function getSessionPiFirstUserMessage(
  projectSlug: string,
  sessionId: string,
): Promise<string | undefined> {
  const files = await piLogsForSession(projectSlug, sessionId)
  for (const file of files) {
    const msg = await scanJsonlForward(file, (entry) => getUserMessageText(entry as PiMessageEntry))
    if (msg !== undefined) return msg
  }
  return undefined
}

/**
 * Whether a pi session log exists — the marker that a session ran pi, used by
 * restart's tool inference once the pod is gone.
 */
export async function hasPiSessionLog(projectSlug: string, sessionId: string): Promise<boolean> {
  const files = await piLogsForSession(projectSlug, sessionId)
  return files.length > 0
}

/**
 * Deleted-session records for every pi session of a project: one per session id
 * found among the JSONL logs in the shared `.pi` home. Logs are grouped by the
 * id in their filename (a session normally has one log, but a resume from a
 * different cwd can leave a second sharing that id). birthtime (oldest log) is
 * the creation signal; mtime (newest log) is last-activity — the pi arm of
 * `listDeletedSessions` (pi leaves host JSONL, unlike opencode, so no meta
 * cache is consulted).
 */
export async function listPiSessionRecords(
  slug: string,
): Promise<Array<{ sessionId: string; birthtimeMs: number; lastActiveMs: number }>> {
  const files = await listPiJsonlFiles(piSessionsDir(slug))
  const byId = new Map<string, string[]>()
  for (const f of files) {
    const id = sessionIdFromPiLog(f)
    if (id === undefined) continue
    const group = byId.get(id)
    if (group) group.push(f)
    else byId.set(id, [f])
  }
  const records: Array<{ sessionId: string; birthtimeMs: number; lastActiveMs: number }> = []
  for (const [sessionId, group] of byId) {
    let birthtimeMs = Infinity
    let lastActiveMs = 0
    for (const f of group) {
      try {
        const s = await fs.stat(f)
        birthtimeMs = Math.min(birthtimeMs, s.birthtimeMs)
        lastActiveMs = Math.max(lastActiveMs, s.mtimeMs)
      } catch {
        // unstattable — skip this file
      }
    }
    if (!Number.isFinite(birthtimeMs)) continue
    records.push({ sessionId, birthtimeMs, lastActiveMs })
  }
  return records
}
