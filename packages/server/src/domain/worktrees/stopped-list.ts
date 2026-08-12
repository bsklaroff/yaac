import { worktreeRuntime } from '#runtime/driver'
import { getAgentSessionFirstMessage } from '#runtime/agents'
import { sessionTranscriptPath, toProjectRelative, transcriptLastActiveMs } from '#store/transcripts'
import { listWorktreeRows, type WorktreeRow } from '#db'
import {
  getAgentSessionsFor,
  setAgentSessionCapture,
  type AgentSessionLinkRow,
} from '#db'
import { toAgentSessionEntry } from './agent-session-entry'
import { absoluteTranscriptPath } from './agent-session-paths'
import { ensureProjectExists } from './list'
import { formatUtcTimestamp } from '@yaac/shared/time'
import type { StoppedWorktreeEntry } from '@yaac/shared/types'

/**
 * Worktrees yaac has recorded that no longer have a worktree pod — stopped,
 * not deleted: the git worktree is still on disk with its diff intact, which
 * is what makes the restart action meaningful. If the cluster is not
 * reachable, every recorded worktree is treated as stopped.
 *
 * Entries are sorted newest-first and sliced to `limit` before any file is
 * touched, so only the rows the caller will render pay for their
 * last-activity stat. Pass `undefined` / `0` to disable the limit.
 */
export async function listStoppedWorktrees(
  projectFilter?: string,
  limit?: number,
): Promise<StoppedWorktreeEntry[]> {
  if (projectFilter) await ensureProjectExists(projectFilter)

  const runningIds = new Set<string>()
  try {
    for (const w of await worktreeRuntime().list()) {
      if (w.workspaceId) runningIds.add(w.workspaceId)
    }
  } catch {
    // substrate not reachable — treat all as stopped
  }

  const rows = (await listWorktreeRows(projectFilter))
    .filter((r) => !runningIds.has(r.worktreeId))

  // Newest-stopped first, falling back to creation time for a worktree
  // removed out of band (no recorded stop).
  const sortKey = (r: WorktreeRow): number => (r.stoppedAt ?? r.createdAt).getTime()
  rows.sort((a, b) => sortKey(b) - sortKey(a) || b.createdAt.getTime() - a.createdAt.getTime())

  // A pinned worktree drives a sidebar row, so it survives the cap no matter
  // how far down the ordering it falls.
  const capped = limit && limit > 0
    ? rows.filter((r, i) => i < limit || r.background)
    : rows

  const linksByWorktree = await getAgentSessionsFor(capped.map((r) => ({
    projectSlug: r.projectSlug,
    worktreeId: r.worktreeId,
  })))

  return Promise.all(capped.map(async (r) => {
    const links = linksByWorktree.get(`${r.projectSlug}/${r.worktreeId}`) ?? []
    const first = links[0]
    const prompt = await stoppedPrompt(r, links)
    return {
      worktreeId: r.worktreeId,
      projectSlug: r.projectSlug,
      // Both read off the first conversation — a worktree has no tool of its
      // own. A row with none recorded predates that and reads as claude,
      // which is what restart falls back to as well.
      tool: first?.tool ?? 'claude',
      createdAt: formatUtcTimestamp(r.createdAt.getTime()),
      lastActiveAt: formatUtcTimestamp(await lastActiveMs(r, links) ?? r.createdAt.getTime()),
      agentSessions: links.map((l) => toAgentSessionEntry(l)),
      seen: r.deathSeen,
      ...(prompt !== undefined ? { prompt } : {}),
      ...(r.title !== undefined ? { title: r.title } : {}),
      ...(r.stoppedAt !== undefined ? { stoppedAt: formatUtcTimestamp(r.stoppedAt.getTime()) } : {}),
      ...(r.deathReason !== undefined ? { deathReason: r.deathReason } : {}),
      ...(r.deathDetail !== undefined ? { deathDetail: r.deathDetail } : {}),
      ...(r.background ? { background: true } : {}),
    }
  }))
}

/**
 * When the worktree last saw activity: the newest transcript mtime across
 * every conversation it has hosted. Taking the max rather than the first
 * conversation's is what makes a worktree the user `/clear`ed an hour ago
 * sort as an hour old instead of as old as its opening question.
 *
 * Falls back to the recorded `lastActiveAt` when a transcript is gone, and
 * yields undefined for a worktree with nothing readable (an opencode one,
 * whose history lives only inside the container).
 */
async function lastActiveMs(
  r: WorktreeRow,
  links: AgentSessionLinkRow[],
): Promise<number | undefined> {
  const stamps = await Promise.all(links.map(async (l) => {
    const recorded = absoluteTranscriptPath(l)
    const fromDisk = recorded === undefined
      ? undefined
      : await transcriptLastActiveMs(recorded)
    return fromDisk ?? l.lastActiveAt?.getTime()
  }))
  const known = stamps.filter((s): s is number => s !== undefined)
  if (known.length > 0) return Math.max(...known)
  // No links yet — a worktree that died before the registry's first tick
  // ever ran. Fall back to the conversation the old pin guarantees, so its
  // listing doesn't report its birth time as last-activity forever.
  const pinned = await sessionTranscriptPath(
    r.projectSlug, r.worktreeId, links[0]?.tool ?? 'claude',
  )
  return pinned === undefined ? undefined : await transcriptLastActiveMs(pinned)
}

/**
 * The worktree's founding ask, parsed from its first conversation's transcript
 * on demand for one that died before the capture step ever ran. The result is
 * persisted, so a given worktree parses at most once. opencode leaves no host transcript, so an uncaptured opencode
 * worktree simply has no prompt.
 */
async function stoppedPrompt(
  r: WorktreeRow,
  links: AgentSessionLinkRow[],
): Promise<string | undefined> {
  const first = links[0]
  if (first === undefined) return undefined
  if (first.firstPrompt !== undefined) return first.firstPrompt
  // The recorded path first, then the conventional one for the conversation
  // pinned to the worktree id. That second attempt is not redundant: the
  // registry only stamps transcript paths for *running* pods, so a worktree
  // whose pod died while the server was down — or within a tick of the agent
  // starting — has a link with no path, and parsing from disk is the only way
  // its prompt is ever recovered. `lastActiveMs` keeps the same fallback for
  // the same reason.
  const path = absoluteTranscriptPath(first)
    ?? await sessionTranscriptPath(r.projectSlug, r.worktreeId, first.tool)
  const prompt = await getAgentSessionFirstMessage(first.tool, path)
  if (prompt === undefined) return undefined
  // Back to the column's form before recording it: the fallback above is an
  // absolute path derived from the tool's layout, and the column takes only
  // project-relative. An unexpressible one is left out, which leaves whatever
  // an earlier pass recorded alone.
  const stored = path !== undefined ? toProjectRelative(r.projectSlug, path) : null
  await setAgentSessionCapture(r.projectSlug, first.tool, first.agentSessionId, {
    firstPrompt: prompt,
    ...(stored !== null ? { transcriptPath: stored } : {}),
  })
  return prompt
}
