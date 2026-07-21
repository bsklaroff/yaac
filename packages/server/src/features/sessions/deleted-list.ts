import fs from 'node:fs/promises'
import path from 'node:path'
import { listSessionPods } from '#platform/k8s/pods'
import { claudeDir, codexTranscriptDir, getProjectsDir } from '@yaac/shared/project-paths'
import { getSessionFirstMessage, listBackgroundSessionIds } from '#features/sessions/state'
import { listOpencodeMetaEntries } from '#features/sessions/agents/opencode'
import { listPiSessionRecords } from '#features/sessions/agents/pi-status'
import { listDeletedInfo } from '#features/sessions/deleted-store'
import { getSessionTitles } from '#features/titles/titles'
import { ensureProjectExists } from '#features/sessions/list'
import { formatUtcTimestamp } from '@yaac/shared/time'
import type { DeletedSessionEntry } from '@yaac/shared/types'

/** A deleted-session entry plus the ms-precision timestamps the listing
 *  sorts by (the entry's own strings are truncated to second precision for
 *  display). `deletedAtMs` is set only when a deletion time was recorded. */
interface CollectedDeleted {
  entry: DeletedSessionEntry
  birthtimeMs: number
  lastActiveMs: number
  deletedAtMs?: number
}

/**
 * Scan the Claude Code JSONL dirs, Codex transcript dirs, and opencode
 * meta caches for session ids that no longer have a matching session
 * pod. If the cluster is not reachable, every saved session is treated
 * as deleted.
 *
 * Entries are sorted newest-first and sliced to `limit` before prompts
 * are read — parsing each JSONL only for the rows the caller will render.
 * Pass `undefined` / `0` to disable the limit.
 */
export async function listDeletedSessions(
  projectFilter?: string,
  limit?: number,
): Promise<DeletedSessionEntry[]> {
  if (projectFilter) await ensureProjectExists(projectFilter)

  const slugs: string[] = []
  if (projectFilter) {
    slugs.push(projectFilter)
  } else {
    try {
      const entries = await fs.readdir(getProjectsDir())
      slugs.push(...entries)
    } catch {
      return []
    }
  }

  const activeSessionIds = new Set<string>()
  try {
    const pods = await listSessionPods()
    for (const p of pods) {
      if (p.sessionId) activeSessionIds.add(p.sessionId)
    }
  } catch {
    // cluster not reachable — treat all as deleted
  }

  /**
   * Scan one per-tool record dir for deleted-session files: readdir →
   * filter by extension → skip active session ids → stat. A missing dir
   * or an unstattable file is skipped silently. Tracks ms-precision
   * birthtime and mtime alongside each entry: mtime (last transcript
   * append) is the last-activity signal, and birthtime tiebreaks the sort
   * for entries created in the same second (createdAt is truncated to
   * second precision for display). These are server-written regular files
   * (never symlinks), so plain `fs.stat` is used.
   */
  async function collectDeleted(
    dir: string,
    ext: string,
    tool: DeletedSessionEntry['tool'],
    slug: string,
  ): Promise<CollectedDeleted[]> {
    const out: CollectedDeleted[] = []
    let files: string[]
    try {
      files = await fs.readdir(dir)
    } catch {
      return out // no record dir for this tool
    }
    for (const file of files) {
      if (!file.endsWith(ext)) continue
      const sessionId = file.slice(0, -ext.length)
      if (activeSessionIds.has(sessionId)) continue
      try {
        const stat = await fs.stat(path.join(dir, file))
        out.push({
          entry: {
            sessionId,
            projectSlug: slug,
            tool,
            createdAt: formatUtcTimestamp(stat.birthtimeMs),
            lastActiveAt: formatUtcTimestamp(stat.mtimeMs),
            // Overwritten below for sessions with a deleted_sessions row; a
            // session removed out-of-band (no row, no death) stays false.
            seen: false,
          },
          birthtimeMs: stat.birthtimeMs,
          lastActiveMs: stat.mtimeMs,
        })
      } catch {
        continue
      }
    }
    return out
  }

  const collected: CollectedDeleted[] = []
  for (const slug of slugs) {
    collected.push(...await collectDeleted(
      path.join(claudeDir(slug), 'projects', '-workspace'), '.jsonl', 'claude', slug,
    ))
    collected.push(...await collectDeleted(codexTranscriptDir(slug), '.jsonl', 'codex', slug))
    // opencode's per-session sqlite data dir is created for every
    // session regardless of tool, so it can't identify opencode
    // sessions. The meta cache (first-message snapshot, keyed by
    // session id) is written only for opencode sessions and survives
    // container teardown, making it the authoritative deleted-session
    // record — the same source getDeletedSessionOpencodeFirstUserMessage
    // reads from. opencode leaves no host transcript, so there's no
    // per-turn activity signal: last-activity is approximated as the later
    // of the meta row's first-message capture and its creation time.
    for (const meta of await listOpencodeMetaEntries(slug)) {
      if (activeSessionIds.has(meta.sessionId)) continue
      const birthtimeMs = meta.createdAt.getTime()
      const capturedMs = meta.capturedAt ? Date.parse(meta.capturedAt) : NaN
      const lastActiveMs = Number.isNaN(capturedMs) ? birthtimeMs : Math.max(birthtimeMs, capturedMs)
      collected.push({
        entry: {
          sessionId: meta.sessionId,
          projectSlug: slug,
          tool: 'opencode',
          createdAt: formatUtcTimestamp(birthtimeMs),
          lastActiveAt: formatUtcTimestamp(lastActiveMs),
          seen: false, // overwritten below when a deleted_sessions row exists
        },
        birthtimeMs,
        lastActiveMs,
      })
    }
    // pi leaves host JSONL logs (one subdir per session), so — unlike
    // opencode — its deleted sessions are enumerated straight from disk.
    for (const rec of await listPiSessionRecords(slug)) {
      if (activeSessionIds.has(rec.sessionId)) continue
      collected.push({
        entry: {
          sessionId: rec.sessionId,
          projectSlug: slug,
          tool: 'pi',
          createdAt: formatUtcTimestamp(rec.birthtimeMs),
          lastActiveAt: formatUtcTimestamp(rec.lastActiveMs),
          seen: false, // overwritten below when a deleted_sessions row exists
        },
        birthtimeMs: rec.birthtimeMs,
        lastActiveMs: rec.lastActiveMs,
      })
    }
  }

  // Enrich with recorded deletion times (the primary sort key) and death
  // causes, one query per project. A session removed out-of-band has no row
  // and falls back to its last-activity time.
  const deletedAtSlugs = [...new Set(collected.map((r) => r.entry.projectSlug))]
  const deletedAtBySlug = new Map(await Promise.all(
    deletedAtSlugs.map(async (slug) => [slug, await listDeletedInfo(slug)] as const),
  ))
  for (const r of collected) {
    const record = deletedAtBySlug.get(r.entry.projectSlug)?.get(r.entry.sessionId)
    if (record) {
      r.deletedAtMs = record.deletedAt.getTime()
      r.entry.deletedAt = formatUtcTimestamp(r.deletedAtMs)
      r.entry.deathReason = record.deathReason
      r.entry.deathDetail = record.deathDetail
      r.entry.seen = record.seen
    }
  }

  // Mark background pins before the limit slice — a pinned deleted session
  // drives a sidebar row, so it must survive the cap no matter how far down
  // the newest-deleted ordering it falls.
  const backgroundSlugs = [...new Set(collected.map((r) => r.entry.projectSlug))]
  const backgroundBySlug = new Map(await Promise.all(
    backgroundSlugs.map(async (slug) => [slug, await listBackgroundSessionIds(slug)] as const),
  ))
  for (const r of collected) {
    if (backgroundBySlug.get(r.entry.projectSlug)?.has(r.entry.sessionId)) r.entry.background = true
  }

  // Newest-deleted first: sort by recorded deletion time, falling back to
  // last-activity for out-of-band deletions, with birthtime as a stable
  // tiebreak within the same second.
  collected.sort((a, b) =>
    (b.deletedAtMs ?? b.lastActiveMs) - (a.deletedAtMs ?? a.lastActiveMs)
    || b.birthtimeMs - a.birthtimeMs)
  const slice = limit && limit > 0
    ? collected.filter((r, i) => i < limit || r.entry.background)
    : collected
  const capped = slice.map((r) => r.entry)
  const deletedTitleSlugs = [...new Set(capped.map((e) => e.projectSlug))]
  const deletedTitles = new Map(await Promise.all(
    deletedTitleSlugs.map(async (slug) => [slug, await getSessionTitles(slug)] as const),
  ))
  await Promise.all(capped.map(async (entry) => {
    entry.prompt = await getSessionFirstMessage(entry.projectSlug, entry.sessionId, entry.tool)
    entry.title = deletedTitles.get(entry.projectSlug)?.[entry.sessionId]
  }))
  return capped
}
