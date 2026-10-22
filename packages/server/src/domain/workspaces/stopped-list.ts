import { workspaceDriver } from '#drivers/driver'
import {
  getAgentSessionsFor,
  listProjectRows,
  listStoppedWorkspaceRows,
  conversationTitle,
  openingPrompt,
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
  /** Only the projects this user owns, when no `project` is named. */
  owner?: string
  /** Searched in the user, agent and generated titles, first prompts and
   *  tools. */
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
  const projectIds = query.project !== undefined
    ? [query.project]
    : query.owner !== undefined
      ? (await listProjectRows()).filter((p) => p.owner === query.owner).map((p) => p.id)
      : undefined
  const { rows, total } = await listStoppedWorkspaceRows({
    projectIds,
    q: query.q,
    groupId: query.group,
    excludeGroupIds: query.excludeGroups,
    workspaceId: query.workspace,
    excludeIds: [...await runningIds(), ...query.exclude ?? []],
  }, {
    // One past the page, so a page that ends with the last row offers no
    // next one.
    limit: query.limit !== undefined ? query.limit + 1 : undefined,
    after: query.cursor ? parseCursor(query.cursor) : undefined,
  })

  const more = query.limit !== undefined && rows.length > query.limit
  const page = more ? rows.slice(0, query.limit) : rows
  const entries = await toStoppedEntries(page)
  const last = page.at(-1)
  return {
    entries,
    total,
    ...(more && last !== undefined ? { nextCursor: `${stoppedAtOf(last).getTime()}:${last.workspaceId}` } : {}),
  }
}

/** Stopped rows in wire form, with their conversations. */
export async function toStoppedEntries(rows: WorkspaceRow[]): Promise<StoppedWorkspaceEntry[]> {
  const linksByWorkspace = await getAgentSessionsFor(rows)
  return rows.map((r) => {
    const links = linksByWorkspace.get(`${r.projectId}/${r.workspaceId}`) ?? []
    const first = links[0]
    const prompt = openingPrompt(links) ?? r.pendingPrompt
    const title = r.title ?? conversationTitle(links) ?? r.generatedTitle
    return {
      workspaceId: r.workspaceId,
      projectId: r.projectId,
      // From the first conversation; claude if none, as restart assumes.
      tool: first?.tool ?? 'claude',
      createdAt: formatUtcTimestamp(r.createdAt.getTime()),
      lastActiveAt: formatUtcTimestamp(lastActiveMs(links) ?? r.createdAt.getTime()),
      stoppedAt: formatUtcTimestamp(stoppedAtOf(r).getTime()),
      agentSessions: links.map((l) => toAgentSessionEntry(l)),
      deathSeenBy: r.deathSeenBy,
      ...(prompt !== undefined ? { prompt } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(r.deathReason !== undefined ? { deathReason: r.deathReason } : {}),
      ...(r.deathDetail !== undefined ? { deathDetail: r.deathDetail } : {}),
      ...(r.groupId !== undefined ? { groupId: r.groupId } : {}),
    }
  })
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
