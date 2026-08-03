import { listSessionPods } from '#platform/k8s/pods'
import { listSessionRows, setSessionCapture, type SessionRow } from '#features/sessions/store'
import { sessionTranscriptPath, transcriptLastActiveMs } from '#features/sessions/transcripts'
import { getSessionFirstMessage } from '#features/sessions/state'
import { ensureProjectExists } from '#features/sessions/list'
import { formatUtcTimestamp } from '@yaac/shared/time'
import type { DeletedSessionEntry } from '@yaac/shared/types'

/**
 * Sessions yaac has recorded that no longer have a session pod. If the
 * cluster is not reachable, every recorded session is treated as deleted.
 *
 * Entries are sorted newest-first and sliced to `limit` before any file is
 * touched, so only the rows the caller will render pay for their
 * last-activity stat (and, for a session recorded before its first message
 * was captured, one transcript parse — persisted, so it happens once).
 * Pass `undefined` / `0` to disable the limit.
 */
export async function listDeletedSessions(
  projectFilter?: string,
  limit?: number,
): Promise<DeletedSessionEntry[]> {
  if (projectFilter) await ensureProjectExists(projectFilter)

  const activeSessionIds = new Set<string>()
  try {
    for (const p of await listSessionPods()) {
      if (p.sessionId) activeSessionIds.add(p.sessionId)
    }
  } catch {
    // cluster not reachable — treat all as deleted
  }

  const rows = (await listSessionRows(projectFilter))
    .filter((r) => !activeSessionIds.has(r.sessionId))

  // Newest-deleted first, falling back to creation time for a session
  // removed out of band (no recorded deletion).
  const sortKey = (r: SessionRow): number => (r.deletedAt ?? r.createdAt).getTime()
  rows.sort((a, b) => sortKey(b) - sortKey(a) || b.createdAt.getTime() - a.createdAt.getTime())

  // A pinned session drives a sidebar row, so it survives the cap no matter
  // how far down the ordering it falls.
  const capped = limit && limit > 0
    ? rows.filter((r, i) => i < limit || r.background)
    : rows

  return Promise.all(capped.map(async (r) => {
    const lastActiveMs = r.transcriptPath
      ? await transcriptLastActiveMs(r.transcriptPath)
      : undefined
    return {
      sessionId: r.sessionId,
      projectSlug: r.projectSlug,
      tool: r.tool,
      createdAt: formatUtcTimestamp(r.createdAt.getTime()),
      lastActiveAt: formatUtcTimestamp(lastActiveMs ?? r.createdAt.getTime()),
      prompt: await deletedPrompt(r),
      seen: r.deathSeen,
      ...(r.title !== undefined ? { title: r.title } : {}),
      ...(r.deletedAt !== undefined ? { deletedAt: formatUtcTimestamp(r.deletedAt.getTime()) } : {}),
      ...(r.deathReason !== undefined ? { deathReason: r.deathReason } : {}),
      ...(r.deathDetail !== undefined ? { deathDetail: r.deathDetail } : {}),
      ...(r.background ? { background: true } : {}),
    }
  }))
}

/**
 * The row's captured first message, parsed from the transcript on demand
 * for a session that died before the capture step ever ran (or that the
 * backfill adopted). The result is persisted, so a given session parses at
 * most once. opencode leaves no host transcript, so an uncaptured opencode
 * session simply has no prompt.
 */
async function deletedPrompt(r: SessionRow): Promise<string | undefined> {
  if (r.prompt !== undefined) return r.prompt
  const prompt = await getSessionFirstMessage(r.projectSlug, r.sessionId, r.tool)
  if (prompt === undefined) return undefined
  // Stamp the path it was parsed from too, so the next listing stats the
  // transcript for last-activity instead of falling back to creation time.
  await setSessionCapture(r.projectSlug, r.sessionId, {
    prompt,
    transcriptPath: await sessionTranscriptPath(r.projectSlug, r.sessionId, r.tool),
  })
  return prompt
}
