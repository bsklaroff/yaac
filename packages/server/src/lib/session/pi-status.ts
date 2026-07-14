import fs from 'node:fs/promises'
import path from 'node:path'
import type { Dirent } from 'node:fs'
import { piSessionsDir, piSessionsRootDir } from '@yaac/shared/project-paths'
import { scanJsonlForward } from '#lib/session/jsonl'

/**
 * Status classification + first-message lookup for pi (earendil) sessions.
 *
 * Unlike opencode, pi writes plain JSONL session logs to a host-mounted dir
 * (`piSessionsDir`, pointed at by PI_CODING_AGENT_SESSION_DIR), so the
 * first-message lookup reads those files directly on the host — no HTTP probe
 * and no DB meta cache. The files persist across container teardown, so the
 * live and deleted-session lookups are the same read.
 *
 * Status is read from the rendered tmux pane (window `yaac:pi.0`), captured by
 * the session's status watcher (`src/server/status-watcher.ts`) over its
 * persistent control-mode stream — the same `%output`-dirty-bit path opencode
 * uses — and classified with `classifyPiPane`.
 */

/**
 * Classify a captured pi tmux pane into `running` / `waiting`.
 *
 * pi does not document a busy/idle terminal-title signal, so we read the
 * rendered pane: while a turn is in flight pi shows an interrupt hint
 * ("esc to interrupt" / "esc to cancel") and/or a "working"/"thinking"
 * status; a pane waiting for input carries neither. Defaults to `waiting`
 * (a still-booting pane, or one sitting at the prompt).
 *
 * NOTE: the exact markers are validated against a live pi session — refine
 * these patterns if pi's footer wording differs.
 */
const PI_INTERRUPT_HINT = /esc\s+(?:to\s+)?(?:interrupt|cancel|stop)/i
const PI_WORKING_HINT = /\b(?:thinking|working|generating|streaming|running)\b/i

export function classifyPiPane(paneContent: string): 'running' | 'waiting' {
  if (PI_INTERRUPT_HINT.test(paneContent)) return 'running'
  if (PI_WORKING_HINT.test(paneContent)) return 'running'
  return 'waiting'
}

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
  const files = await listPiJsonlFiles(piSessionsDir(projectSlug, sessionId))
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
  const files = await listPiJsonlFiles(piSessionsDir(projectSlug, sessionId))
  return files.length > 0
}

/**
 * Deleted-session records for every pi session of a project: one per session
 * subdir under `piSessionsRootDir` that still holds a JSONL log. birthtime
 * (oldest log) is the creation signal; mtime (newest log) is last-activity —
 * the pi arm of `listDeletedSessions` (pi leaves host JSONL, unlike opencode,
 * so no meta cache is consulted).
 */
export async function listPiSessionRecords(
  slug: string,
): Promise<Array<{ sessionId: string; birthtimeMs: number; lastActiveMs: number }>> {
  let dirents: Dirent[]
  try {
    dirents = await fs.readdir(piSessionsRootDir(slug), { withFileTypes: true })
  } catch {
    return []
  }
  const records: Array<{ sessionId: string; birthtimeMs: number; lastActiveMs: number }> = []
  for (const d of dirents) {
    if (!d.isDirectory()) continue
    const files = await listPiJsonlFiles(piSessionsDir(slug, d.name))
    if (files.length === 0) continue
    let birthtimeMs = Infinity
    let lastActiveMs = 0
    for (const f of files) {
      try {
        const s = await fs.stat(f)
        birthtimeMs = Math.min(birthtimeMs, s.birthtimeMs)
        lastActiveMs = Math.max(lastActiveMs, s.mtimeMs)
      } catch {
        // unstattable — skip this file
      }
    }
    if (!Number.isFinite(birthtimeMs)) continue
    records.push({ sessionId: d.name, birthtimeMs, lastActiveMs })
  }
  return records
}
