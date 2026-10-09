import { workspaceDriver } from '#drivers/driver'
import {
  getAgentSessionFirstMessage,
  sessionTranscriptPath,
  toProjectRelative,
  transcriptLastActiveMs,
} from '#runtime/agents'
import {
  getAgentSessionsFor,
  listStoppedWorkspaceRows,
  setAgentSessionCapture,
  type AgentSessionLinkRow,
  type StoppedRowCursor,
  type WorkspaceRow,
} from '#db'
import { toAgentSessionEntry } from './agent-session-entry'
import { recordedTranscript } from './agent-session-paths'
import { ensureProjectExists } from './list'
import { ServerError } from '@yaac/shared/errors'
import { formatUtcTimestamp } from '@yaac/shared/time'
import type { StoppedWorkspaceEntry, StoppedWorkspacePage } from '@yaac/shared/types'

/** What `GET /workspace/list-stopped` narrows the listing to. */
export interface StoppedListQuery {
  project?: string
  /** Searched in the title, first prompts and tools. */
  q?: string
  /** Only this group's members. */
  group?: string
  /** Leave out these groups' members: the webapp lists them in their
   *  group instead. */
  excludeGroups?: string[]
  /** Leave out these workspaces: the webapp draws them elsewhere. */
  exclude?: string[]
  /** Only this workspace, for a deep link. */
  workspace?: string
  /** Page size; undefined lists everything after `cursor`. */
  limit?: number
  /** `nextCursor` of the previous page. */
  cursor?: string
}

/**
 * Recorded workspaces with a recorded stop and nothing running (a restart
 * keeps its stop until it succeeds), one page at a time, newest stop first.
 * Transcripts are read only for the page's rows.
 */
export async function listStoppedWorkspaces(query: StoppedListQuery = {}): Promise<StoppedWorkspacePage> {
  if (query.project) await ensureProjectExists(query.project)
  const { rows, total } = await listStoppedWorkspaceRows({
    projectId: query.project,
    q: query.q,
    groupId: query.group,
    excludeGroupIds: query.excludeGroups,
    workspaceId: query.workspace,
    excludeIds: [...await runningIds(), ...query.exclude ?? []],
  }, {
    limit: query.limit,
    after: query.cursor ? parseCursor(query.cursor) : undefined,
  })

  const linksByWorkspace = await getAgentSessionsFor(rows.map((r) => ({
    projectId: r.projectId,
    workspaceId: r.workspaceId,
  })))
  const entries = await Promise.all(rows.map(async (r): Promise<StoppedWorkspaceEntry> => {
    const links = linksByWorkspace.get(`${r.projectId}/${r.workspaceId}`) ?? []
    const first = links[0]
    const prompt = await stoppedPrompt(r, links)
    return {
      workspaceId: r.workspaceId,
      projectId: r.projectId,
      // From the first conversation; claude if none, as restart assumes.
      tool: first?.tool ?? 'claude',
      createdAt: formatUtcTimestamp(r.createdAt.getTime()),
      lastActiveAt: formatUtcTimestamp(await lastActiveMs(r, links) ?? r.createdAt.getTime()),
      stoppedAt: formatUtcTimestamp(stoppedAtOf(r).getTime()),
      agentSessions: links.map((l) => toAgentSessionEntry(l)),
      seen: r.deathSeen,
      ...(prompt !== undefined ? { prompt } : {}),
      ...(r.title !== undefined ? { title: r.title } : {}),
      ...(r.deathReason !== undefined ? { deathReason: r.deathReason } : {}),
      ...(r.deathDetail !== undefined ? { deathDetail: r.deathDetail } : {}),
      ...(r.groupId !== undefined ? { groupId: r.groupId } : {}),
    }
  }))
  const last = rows.at(-1)
  const more = query.limit !== undefined && last !== undefined && rows.length === query.limit
  return {
    entries,
    total,
    ...(more ? { nextCursor: `${stoppedAtOf(last).getTime()}:${last.workspaceId}` } : {}),
  }
}

/** Ids the runtime reports running; none when it is unreachable, since the
 *  recorded stops are still worth listing. */
async function runningIds(): Promise<string[]> {
  try {
    return (await workspaceDriver().list()).map((w) => w.workspaceId).filter(Boolean)
  } catch {
    return []
  }
}

/** Narrows the type: the listing selects only rows with a stop. */
function stoppedAtOf(r: WorkspaceRow): Date {
  if (r.stoppedAt === undefined) throw new Error(`workspace ${r.workspaceId} has no recorded stop`)
  return r.stoppedAt
}

/** `<stop ms>:<workspace id>`, as `listStoppedWorkspaces` writes it. */
function parseCursor(cursor: string): StoppedRowCursor {
  const sep = cursor.indexOf(':')
  const ms = Number(cursor.slice(0, sep))
  if (sep < 0 || !Number.isFinite(ms)) throw new ServerError('VALIDATION', `invalid cursor: ${cursor}`)
  return { stoppedAt: new Date(ms), workspaceId: cursor.slice(sep + 1) }
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
    r.projectId, r.workspaceId, links[0]?.tool ?? 'claude',
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
    ?? await sessionTranscriptPath(r.projectId, r.workspaceId, first.tool)
  const prompt = await getAgentSessionFirstMessage(first.tool, transcript)
  if (prompt === undefined) return undefined
  // The column is project-relative; skip the path if it cannot be expressed.
  const stored = transcript !== undefined ? toProjectRelative(transcript) : null
  await setAgentSessionCapture(r.projectId, first.tool, first.agentSessionId, {
    firstPrompt: prompt,
    ...(stored !== null ? { transcriptPath: stored } : {}),
  })
  return prompt
}
