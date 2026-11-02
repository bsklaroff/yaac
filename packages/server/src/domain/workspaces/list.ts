import {
  getProjectConversations,
  getProjectRow,
  getProjectWorkspaceRows,
  conversationTitle,
  listOpenSessionsFor,
  openingPrompt,
  routineRunWorkspaces,
  type ConversationLinkRow,
  type SessionRow,
  type WorkspaceRow,
} from '#db'
import { listedStatus, toConversationEntry, toSessionEntry } from './conversation-entry'
import { HELD_PROMPT_GRACE_MS } from './conversation-registry'
import { notifyWorkspaceListChanged } from '#lib/notify'
import { ServerError } from '@yaac/shared/errors'
import { formatUtcTimestamp } from '@yaac/shared/time'
import { observeWorkspaces, type WorkspaceRuntimeReport } from '#runtime/status'
import { KEEPER_STARTING, KEEPER_WINDOW, type WorkspaceWindow } from '#drivers/contract'
import type { ActiveWorkspacesResult, SessionEntry, WorkspaceListEntry, WorkspaceTerminalEntry } from '@yaac/shared/types'

export async function ensureProjectExists(projectId: string): Promise<void> {
  if (!await getProjectRow(projectId)) {
    throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  }
}

/**
 * In-flight `listActiveWorkspaces` calls by `projectFilter ?? ''`. Each call
 * is a full substrate observation, so overlapping callers share one.
 */
const listActiveInflight = new Map<string, Promise<ActiveWorkspacesResult>>()

/**
 * The earliest end of a held prompt's grace the listings have seen, and the
 * timer that republishes the snapshot then. A start that hangs silently
 * changes nothing else, so without it the row would keep listing as working
 * until some unrelated change rebuilt the snapshot. The next listing arms
 * the following end.
 */
let graceEnd: { at: number; timer: NodeJS.Timeout } | undefined

function republishAt(at: number): void {
  if (graceEnd !== undefined && graceEnd.at <= at) return
  clearTimeout(graceEnd?.timer)
  const timer = setTimeout(() => {
    graceEnd = undefined
    notifyWorkspaceListChanged()
  }, at - Date.now())
  timer.unref()
  graceEnd = { at, timer }
}

/** Test helper: drop shared in-flight calls and the grace timer between
 *  test cases. */
export function _clearListActiveInflightForTests(): void {
  listActiveInflight.clear()
  clearTimeout(graceEnd?.timer)
  graceEnd = undefined
}

/**
 * Active workspaces for display, plus the stale set the caller should tear
 * down. Joins what the runtime observes now with recorded rows (title,
 * group, creation time, conversations) (docs/layered-server.md).
 *
 * A chat session still holding its opening prompt (`pendingPrompt`) lists
 * as `running` rather than `waiting`, and so does its workspace when
 * nothing else waits: its agent is starting up to work on that prompt, so
 * the `waiting` the status store reports before the first turn would show
 * an unread reply that does not exist. Only within `HELD_PROMPT_GRACE_MS`
 * of the latest of the session's opening, the runtime's creation, and the
 * wait's start (the agent's attach or first status), after which the start
 * is stuck and its real status shows, as a wait clients have not seen yet.
 * Each covers a case the others start too early for: a cold create opens
 * its session before a slow image build and boot, a runtime's watcher takes
 * a moment to attach, and a claimed spare's agent may have been waiting
 * since it was warmed.
 */
export async function listActiveWorkspaces(projectFilter?: string): Promise<ActiveWorkspacesResult> {
  const key = projectFilter ?? ''
  const existing = listActiveInflight.get(key)
  if (existing) return existing
  const promise = listActiveWorkspacesImpl(projectFilter).finally(() => {
    listActiveInflight.delete(key)
  })
  listActiveInflight.set(key, promise)
  return promise
}

async function listActiveWorkspacesImpl(projectFilter?: string): Promise<ActiveWorkspacesResult> {
  if (projectFilter) await ensureProjectExists(projectFilter)

  const report = await observeWorkspaces(projectFilter)

  // Rows and conversations are read with one query per project each.
  const rowProjectIds = [...new Set(report.workspaces.map((w) => w.projectId).filter((v) => !!v))]
  const rowsByProject = new Map(await Promise.all(
    rowProjectIds.map(async (projectId) => [projectId, await getProjectWorkspaceRows(projectId)] as const),
  ))
  const rowFor = (w: WorkspaceRuntimeReport): WorkspaceRow | undefined =>
    w.projectId && w.workspaceId ? rowsByProject.get(w.projectId)?.get(w.workspaceId) : undefined
  const routineRuns = report.workspaces.length > 0 ? await routineRunWorkspaces() : new Map<string, string>()

  const idsByProject = new Map<string, string[]>()
  for (const w of report.workspaces) {
    if (!w.projectId || !w.workspaceId) continue
    idsByProject.set(w.projectId, [...(idsByProject.get(w.projectId) ?? []), w.workspaceId])
  }
  const agentsByProject = new Map(await Promise.all(
    rowProjectIds.map(async (projectId) =>
      [projectId, await getProjectConversations(projectId, idsByProject.get(projectId) ?? [])] as const),
  ))
  const agentsFor = (w: WorkspaceRuntimeReport): ConversationLinkRow[] =>
    (w.projectId && w.workspaceId
      ? agentsByProject.get(w.projectId)?.get(w.workspaceId)
      : undefined) ?? []
  const sessionsByWorkspace = await listOpenSessionsFor(report.workspaces.map((w) => w.workspaceId).filter((v) => !!v))

  const workspaces = report.workspaces.map((w): WorkspaceListEntry => {
    const row = rowFor(w)
    const links = agentsFor(w)
    const sessions = sessionsByWorkspace.get(w.workspaceId) ?? []
    const base = {
      workspaceId: w.workspaceId,
      projectId: w.projectId,
      // The recorded time survives a runtime restart; fall back if no row yet.
      createdAt: formatUtcTimestamp((row?.createdAt ?? new Date(w.createdAtMs)).getTime()),
      prompt: openingPrompt(links) ?? sessions[0]?.firstPrompt,
      title: row?.title ?? conversationTitle(links) ?? row?.generatedTitle,
      groupId: row?.groupId,
      conversations: links.map(toConversationEntry),
      ...(row?.deadline !== undefined ? { deadline: row.deadline.toISOString() } : {}),
      ...(routineRuns.has(w.workspaceId) ? { routineId: routineRuns.get(w.workspaceId) } : {}),
    }
    if (w.phase === 'terminating') {
      // Non-interactive placeholder: no ports, and `running` so no attention
      // badge fires. Sessions are kept only to show the model.
      return {
        ...base,
        status: 'running',
        stopping: true,
        sessions: sessions.map((s) => toSessionEntry(s, links)),
        blockedHosts: [],
        forwardedPorts: [],
        unforwardedPorts: [],
      }
    }
    const starting = new Set<string>()
    const entries = sessions.map((s) => {
      const entry = toSessionEntry(s, links, { agents: w.agents, ...(w.windows !== undefined ? { windows: w.windows } : {}) })
      const until = startingUntil(s, entry, w)
      if (until === undefined) return entry
      starting.add(s.id)
      republishAt(until)
      if (entry.status !== 'waiting' || entry.asking === true || entry.exited === true) return entry
      const { waitingSinceMs: _, ...rest } = entry
      return { ...rest, status: 'running' as const }
    })
    return {
      ...base,
      ...workspaceStatus(entries, w, starting.size > 0),
      sessions: entries,
      ...(w.windows !== undefined ? { terminals: terminalsOf(w.windows, sessions) } : {}),
      blockedHosts: w.blockedHosts,
      forwardedPorts: w.forwardedPorts,
      unforwardedPorts: w.unforwardedPorts,
      baseBranch: row?.baseBranch,
      ...(row !== undefined && row.trackedScratchDirs.length > 0 ? { trackedScratchDirs: row.trackedScratchDirs } : {}),
    }
  })

  // Project-wide, so reported even with no running workspaces.
  const gitAuthFailures = projectFilter
    ? (report.gitAuthFailures[projectFilter]
      ? { [projectFilter]: report.gitAuthFailures[projectFilter] }
      : {})
    : report.gitAuthFailures

  return { workspaces, stale: report.stale, gitAuthFailures }
}

/**
 * The workspace's status from its sessions': the runtime's aggregate while
 * any is running, `idle` with none. A session whose agent exited waits on
 * the user, so it makes the workspace `waiting` unless an ask is open, in a
 * spell that began at the earliest such wait.
 */
function workspaceStatus(
  sessions: SessionEntry[],
  w: WorkspaceRuntimeReport,
  starting: boolean,
): Pick<WorkspaceListEntry, 'status' | 'asking' | 'waitingSinceMs'> {
  if (sessions.length === 0) return { status: 'idle' }
  const live = sessions.filter((s) => s.exited !== true)
  const runtime = live.length === 0
    ? undefined
    : starting && w.status === 'waiting' && !live.some((s) => s.status === 'waiting')
      ? { status: 'running' as const }
      : { ...listedStatus(w.status), ...(w.waitingSinceMs !== undefined ? { waitingSinceMs: w.waitingSinceMs } : {}) }
  if (runtime !== undefined && (live.length === sessions.length || runtime.asking === true)) return runtime
  const spells = sessions.flatMap((s) => (s.status === 'waiting' && s.waitingSinceMs !== undefined ? [s.waitingSinceMs] : []))
  return { status: 'waiting', ...(spells.length > 0 ? { waitingSinceMs: Math.min(...spells) } : {}) }
}

/** The windows the webapp opens as terminals: all but the keeper and the
 *  sessions'. */
function terminalsOf(windows: WorkspaceWindow[], sessions: SessionRow[]): WorkspaceTerminalEntry[] {
  const taken = new Set([KEEPER_WINDOW, KEEPER_STARTING, ...sessions.map((s) => s.window)])
  return windows.filter((w) => !taken.has(w.name)).map((w) => ({ target: `window:${w.id}`, name: w.name }))
}

/**
 * When a session still holding its opening prompt stops counting as
 * starting, or undefined once it does not (see `listActiveWorkspaces`).
 */
function startingUntil(s: SessionRow, entry: SessionEntry, w: WorkspaceRuntimeReport): number | undefined {
  if (s.pendingPrompt === undefined) return undefined
  const from = Math.max(s.openedAt.getTime(), w.createdAtMs, entry.waitingSinceMs ?? w.waitingSinceMs ?? 0)
  const until = from + HELD_PROMPT_GRACE_MS
  return Date.now() < until ? until : undefined
}
