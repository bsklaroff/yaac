import { workspaceDriver } from '#drivers/driver'
import {
  getAgentSessionsFor,
  listStoppedWorkspaceRows,
  type AgentSessionLinkRow,
  type StoppedRowCursor,
  type WorkspaceRow,
} from '#db'
import { toAgentSessionEntry } from './agent-session-entry'
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
 * Built from rows alone: the sidebar asks for this on every search and every
 * stop, so it never touches a transcript. The prompt and last activity are
 * what the agent-session registry captured while the workspace ran.
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
  const entries = rows.map((r): StoppedWorkspaceEntry => {
    const links = linksByWorkspace.get(`${r.projectId}/${r.workspaceId}`) ?? []
    const first = links[0]
    const prompt = first?.firstPrompt
    return {
      workspaceId: r.workspaceId,
      projectId: r.projectId,
      // From the first conversation; claude if none, as restart assumes.
      tool: first?.tool ?? 'claude',
      createdAt: formatUtcTimestamp(r.createdAt.getTime()),
      lastActiveAt: formatUtcTimestamp(lastActiveMs(links) ?? r.createdAt.getTime()),
      stoppedAt: formatUtcTimestamp(stoppedAtOf(r).getTime()),
      agentSessions: links.map((l) => toAgentSessionEntry(l)),
      seen: r.deathSeen,
      ...(prompt !== undefined ? { prompt } : {}),
      ...(r.title !== undefined ? { title: r.title } : {}),
      ...(r.deathReason !== undefined ? { deathReason: r.deathReason } : {}),
      ...(r.deathDetail !== undefined ? { deathDetail: r.deathDetail } : {}),
      ...(r.groupId !== undefined ? { groupId: r.groupId } : {}),
    }
  })
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

/** The newest recorded activity across the workspace's conversations, so a
 *  `/clear` counts. Undefined when none was recorded. */
function lastActiveMs(links: AgentSessionLinkRow[]): number | undefined {
  const known = links.flatMap((l) => l.lastActiveAt === undefined ? [] : [l.lastActiveAt.getTime()])
  return known.length > 0 ? Math.max(...known) : undefined
}
