import {
  getProjectConversations,
  getProjectRow,
  getProjectWorkspaceRows,
  conversationTitle,
  openingPrompt,
  routineRunWorkspaces,
  type ConversationLinkRow,
  type WorkspaceRow,
} from '#db'
import { listedStatus, toConversationEntry } from './conversation-entry'
import { HELD_PROMPT_GRACE_MS } from './conversation-registry'
import { notifyWorkspaceListChanged } from '#lib/notify'
import { ServerError } from '@yaac/shared/errors'
import { formatUtcTimestamp } from '@yaac/shared/time'
import { observeWorkspaces, type WorkspaceRuntimeReport } from '#runtime/status'
import type { AgentLiveness } from '#drivers/contract'
import type { ActiveWorkspacesResult, AgentStatus, WorkspaceListEntry } from '@yaac/shared/types'

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
 * A chat workspace still holding its create prompt (`pendingPrompt`) lists
 * as `running`, and so do its waiting conversations: its agent is starting
 * up to work on that prompt, so the `waiting` the status store reports
 * before the first turn would show an unread reply that does not exist.
 * Only within `HELD_PROMPT_GRACE_MS` of the latest of the row's creation,
 * the runtime's, and the wait's start (the agent's attach or first status),
 * after which the start is stuck and its real status shows, as a wait
 * clients have not seen yet. Each covers a case the others start too early
 * for: a cold create writes its row before a slow image build and boot, a
 * runtime's watcher takes a moment to attach, and a claimed spare's agent
 * may have been waiting since it was warmed.
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

  const workspaces = report.workspaces.map((w): WorkspaceListEntry => {
    const row = rowFor(w)
    const links = agentsFor(w)
    const base = {
      workspaceId: w.workspaceId,
      projectId: w.projectId,
      tool: w.tool,
      // The recorded time survives a runtime restart; fall back if no row yet.
      createdAt: formatUtcTimestamp((row?.createdAt ?? new Date(w.createdAtMs)).getTime()),
      prompt: openingPrompt(links) ?? row?.pendingPrompt,
      title: row?.title ?? conversationTitle(links) ?? row?.generatedTitle,
      groupId: row?.groupId,
      ...(row !== undefined ? { mode: row.mode, permissionMode: row.permissionMode } : {}),
      ...(row?.effort !== undefined ? { effort: row.effort } : {}),
      ...(row?.deadline !== undefined ? { deadline: row.deadline.toISOString() } : {}),
      ...(routineRuns.has(w.workspaceId) ? { routineId: routineRuns.get(w.workspaceId) } : {}),
    }
    if (w.phase === 'terminating') {
      // Non-interactive placeholder: no ports, and `running` so no attention
      // badge fires. Conversations are kept only to show the model.
      return {
        ...base,
        status: 'running',
        stopping: true,
        conversations: links.map((l) => toConversationEntry(l)),
        blockedHosts: [],
        forwardedPorts: [],
        unforwardedPorts: [],
      }
    }
    const startingUntil = row?.pendingPrompt !== undefined
      ? Math.max(row.createdAt.getTime(), w.createdAtMs, w.waitingSinceMs ?? 0) + HELD_PROMPT_GRACE_MS
      : undefined
    const starting = startingUntil !== undefined && Date.now() < startingUntil
    if (starting) republishAt(startingUntil)
    const shown = (live: LiveStatus): LiveStatus => (starting && live.status === 'waiting' ? { status: 'running' } : live)
    const status = shown(w)
    return {
      ...base,
      ...listedStatus(status.status),
      ...(status.waitingSinceMs !== undefined ? { waitingSinceMs: status.waitingSinceMs } : {}),
      ...(row !== undefined && row.waitingSeenBy.length > 0 ? { waitingSeenBy: row.waitingSeenBy } : {}),
      conversations: links.map((l) => {
        const live = liveStatus(w.agents, l)
        return toConversationEntry(l, live && shown(live))
      }),
      ...(w.terminals !== undefined ? { terminals: w.terminals } : {}),
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
 * A conversation's status, matched by the handle it was last
 * seen on (tmux pane id under `tui`, acpd window name under `acp`).
 * Undefined for inactive conversations, which lets clients tell "open" from
 * "was open".
 */
function liveStatus(
  agents: AgentLiveness[],
  l: ConversationLinkRow,
): LiveStatus | undefined {
  if (!l.active || l.paneId === undefined) return undefined
  const agent = agents.find((a) => a.handle === l.paneId)
  if (agent === undefined) return undefined
  return {
    status: agent.status,
    ...(agent.waitingSinceMs !== undefined ? { waitingSinceMs: agent.waitingSinceMs } : {}),
  }
}

/** A status as listed, with the start of its waiting spell. */
interface LiveStatus {
  status: AgentStatus
  waitingSinceMs?: number
}
