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
 * Recorded workspaces with nothing running: stopped, with the checkout kept
 * for restart. If the substrate is unreachable, all count as stopped.
 *
 * Sorted newest first and cut to `limit` (grouped workspaces always kept)
 * before reading transcripts, so only listed rows pay for the last-activity
 * stat; rows with no recorded stop pay it up front as their sort key.
 * `undefined` / `0` disables the limit.
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
    // Substrate unreachable: treat all as stopped.
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

  // Newest stop first; rows with no recorded stop sort by last activity.
  const unstoppedActive = new Map(await Promise.all(rows
    .filter((r) => r.stoppedAt === undefined)
    .map(async (r) => [r, await activeMs(r)] as const)))
  const sortKey = (r: WorkspaceRow): number => r.stoppedAt?.getTime() ?? unstoppedActive.get(r) ?? 0
  rows.sort((a, b) => sortKey(b) - sortKey(a) || b.createdAt.getTime() - a.createdAt.getTime())

  // Grouped workspaces show as ghost rows in their sidebar group, so they
  // survive the cap.
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
      // From the first conversation; claude if none, as restart assumes.
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
 * The newest transcript mtime across all the workspace's conversations
 * (so a `/clear` counts), falling back to each one's recorded
 * `lastActiveAt`. Undefined when nothing is readable.
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
  // No readable links (died before the registry ran): try the transcript of
  // the conversation named after the workspace id.
  const pinned = await sessionTranscriptPath(
    r.projectSlug, r.workspaceId, links[0]?.tool ?? 'claude',
  )
  return pinned === undefined ? undefined : await transcriptLastActiveMs(pinned)
}

/**
 * The first prompt, parsed from the first conversation's transcript if the
 * capture step never ran, and saved so it is parsed once. opencode leaves no
 * host transcript, so it gets none.
 */
async function stoppedPrompt(
  r: WorkspaceRow,
  links: AgentSessionLinkRow[],
): Promise<string | undefined> {
  const first = links[0]
  if (first === undefined) return undefined
  if (first.firstPrompt !== undefined) return first.firstPrompt
  // Fall back to the conventional path: the registry records paths only for
  // running pods, so a pod that died early has none.
  const transcript = recordedTranscript(first)
    ?? await sessionTranscriptPath(r.projectSlug, r.workspaceId, first.tool)
  const prompt = await getAgentSessionFirstMessage(first.tool, transcript)
  if (prompt === undefined) return undefined
  // The column is project-relative; skip the path if it cannot be expressed.
  const stored = transcript !== undefined ? toProjectRelative(transcript) : null
  await setAgentSessionCapture(r.projectSlug, first.tool, first.agentSessionId, {
    firstPrompt: prompt,
    ...(stored !== null ? { transcriptPath: stored } : {}),
  })
  return prompt
}
