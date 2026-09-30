import { workspaceDriver } from '#drivers/driver'
import {
  getAgentSessionFirstMessage,
  sessionTranscriptPath,
  toProjectRelative,
  transcriptLastActiveMs,
} from '#runtime/agents'
import { listWorkspaceRows, type WorkspaceRow } from '#db'
import {
  getAgentSessionsFor,
  setAgentSessionCapture,
  type AgentSessionLinkRow,
} from '#db'
import { toAgentSessionEntry } from './agent-session-entry'
import { recordedTranscript } from './agent-session-paths'
import { ensureProjectExists } from './list'
import { formatUtcTimestamp } from '@yaac/shared/time'
import type { StoppedWorkspaceEntry } from '@yaac/shared/types'

/**
 * Workspaces yaac has recorded that no longer have a workspace pod — stopped,
 * not deleted: the checkout is still on disk with its diff intact, which
 * is what makes the restart action meaningful. If the cluster is not
 * reachable, every recorded workspace is treated as stopped.
 *
 * Entries are sorted newest-first and sliced to `limit` before the stopped
 * rows' transcripts are touched, so of those only the ones the caller will
 * render pay for their last-activity stat — a row with no recorded stop pays
 * it up front, since that stat is its sort key. Few rows qualify: the stale
 * reaper stamps a podless row stopped within its grace window, so only rows
 * inside that window pay it (or every live row, when the substrate listing
 * fails). Pass `undefined` / `0` to disable the limit.
 */
export async function listStoppedWorkspaces(
  projectFilter?: string,
  limit?: number,
): Promise<StoppedWorkspaceEntry[]> {
  if (projectFilter) await ensureProjectExists(projectFilter)

  const runningIds = new Set<string>()
  try {
    for (const w of await workspaceDriver().list()) {
      if (w.workspaceId) runningIds.add(w.workspaceId)
    }
  } catch {
    // substrate not reachable — treat all as stopped
  }

  const rows = (await listWorkspaceRows(projectFilter))
    .filter((r) => !runningIds.has(r.workspaceId))

  const linksByWorkspace = await getAgentSessionsFor(rows.map((r) => ({
    projectSlug: r.projectSlug,
    workspaceId: r.workspaceId,
  })))
  const linksOf = (r: WorkspaceRow): AgentSessionLinkRow[] =>
    linksByWorkspace.get(`${r.projectSlug}/${r.workspaceId}`) ?? []
  const activeMs = async (r: WorkspaceRow): Promise<number> =>
    await lastActiveMs(r, linksOf(r)) ?? r.createdAt.getTime()

  // Newest-stopped first. A workspace removed out of band (no recorded stop)
  // sorts by when it was last active instead, so its stamp is read now.
  const unstoppedActive = new Map(await Promise.all(rows
    .filter((r) => r.stoppedAt === undefined)
    .map(async (r) => [r, await activeMs(r)] as const)))
  const sortKey = (r: WorkspaceRow): number => r.stoppedAt?.getTime() ?? unstoppedActive.get(r) ?? 0
  rows.sort((a, b) => sortKey(b) - sortKey(a) || b.createdAt.getTime() - a.createdAt.getTime())

  // A grouped workspace drives a ghost row in its sidebar group, so it survives
  // the cap no matter how far down the ordering it falls. Membership alone is
  // the test — whether the group is actually *shown* depends on its live
  // members, which this listing has no business joining against; the sidebar
  // already filters what it renders, and the extra entries belong in the
  // stopped dialog regardless.
  const capped = limit && limit > 0
    ? rows.filter((r, i) => i < limit || r.groupId !== undefined)
    : rows

  return Promise.all(capped.map(async (r) => {
    const links = linksOf(r)
    const first = links[0]
    const prompt = await stoppedPrompt(r, links)
    return {
      workspaceId: r.workspaceId,
      projectSlug: r.projectSlug,
      // Both read off the first conversation — a workspace has no tool of
      // its own. A row whose create died before recording one reads as
      // claude, which is what restart falls back to as well.
      tool: first?.tool ?? 'claude',
      createdAt: formatUtcTimestamp(r.createdAt.getTime()),
      lastActiveAt: formatUtcTimestamp(unstoppedActive.get(r) ?? await activeMs(r)),
      agentSessions: links.map((l) => toAgentSessionEntry(l)),
      seen: r.deathSeen,
      ...(prompt !== undefined ? { prompt } : {}),
      ...(r.title !== undefined ? { title: r.title } : {}),
      ...(r.stoppedAt !== undefined ? { stoppedAt: formatUtcTimestamp(r.stoppedAt.getTime()) } : {}),
      ...(r.deathReason !== undefined ? { deathReason: r.deathReason } : {}),
      ...(r.deathDetail !== undefined ? { deathDetail: r.deathDetail } : {}),
      ...(r.groupId !== undefined ? { groupId: r.groupId } : {}),
    }
  }))
}

/**
 * When the workspace last saw activity: the newest transcript mtime across
 * every conversation it has hosted. Taking the max rather than the first
 * conversation's is what makes a workspace the user `/clear`ed an hour ago
 * sort as an hour old instead of as old as its opening question.
 *
 * Falls back to the recorded `lastActiveAt` when a transcript is gone, and
 * yields undefined for a workspace with nothing readable (an opencode one,
 * whose history lives only inside the container).
 */
async function lastActiveMs(
  r: WorkspaceRow,
  links: AgentSessionLinkRow[],
): Promise<number | undefined> {
  const stamps = await Promise.all(links.map(async (l) => {
    const recorded = recordedTranscript(l)
    const fromDisk = recorded === undefined
      ? undefined
      : await transcriptLastActiveMs(recorded)
    return fromDisk ?? l.lastActiveAt?.getTime()
  }))
  const known = stamps.filter((s): s is number => s !== undefined)
  if (known.length > 0) return Math.max(...known)
  // No links yet — a workspace that died before the registry's first tick
  // ever ran. Fall back to the conversation the create-time pin guarantees,
  // so its listing doesn't report its birth time as last-activity forever.
  const pinned = await sessionTranscriptPath(
    r.projectSlug, r.workspaceId, links[0]?.tool ?? 'claude',
  )
  return pinned === undefined ? undefined : await transcriptLastActiveMs(pinned)
}

/**
 * The workspace's founding ask, parsed from its first conversation's transcript
 * on demand for one that died before the capture step ever ran. The result is
 * persisted, so a given workspace parses at most once. opencode leaves no host transcript, so an uncaptured opencode
 * workspace simply has no prompt.
 */
async function stoppedPrompt(
  r: WorkspaceRow,
  links: AgentSessionLinkRow[],
): Promise<string | undefined> {
  const first = links[0]
  if (first === undefined) return undefined
  if (first.firstPrompt !== undefined) return first.firstPrompt
  // The recorded path first, then the conventional one for the conversation
  // pinned to the workspace id. That second attempt is not redundant: the
  // registry only stamps transcript paths for *running* pods, so a workspace
  // whose pod died while the server was down — or within a tick of the agent
  // starting — has a link with no path, and parsing from disk is the only way
  // its prompt is ever recovered. `lastActiveMs` keeps the same fallback for
  // the same reason.
  const transcript = recordedTranscript(first)
    ?? await sessionTranscriptPath(r.projectSlug, r.workspaceId, first.tool)
  const prompt = await getAgentSessionFirstMessage(first.tool, transcript)
  if (prompt === undefined) return undefined
  // Back to the column's form before recording it: the column takes only
  // project-relative. An unexpressible one is left out, which leaves whatever
  // an earlier pass recorded alone.
  const stored = transcript !== undefined ? toProjectRelative(transcript) : null
  await setAgentSessionCapture(r.projectSlug, first.tool, first.agentSessionId, {
    firstPrompt: prompt,
    ...(stored !== null ? { transcriptPath: stored } : {}),
  })
  return prompt
}
