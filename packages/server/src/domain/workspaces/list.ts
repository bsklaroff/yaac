import {
  getProjectAgentSessions,
  getProjectRow,
  getProjectWorkspaceRows,
  type AgentSessionLinkRow,
  type WorkspaceRow,
} from '#db'
import { listedStatus, toAgentSessionEntry } from './agent-session-entry'
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

/** Test helper: drop shared in-flight calls between test cases. */
export function _clearListActiveInflightForTests(): void {
  listActiveInflight.clear()
}

/**
 * Active workspaces for display, plus the stale set the caller should tear
 * down. Joins what the runtime observes now with recorded rows (title,
 * group, creation time, conversations) (docs/layered-server.md).
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

  const idsByProject = new Map<string, string[]>()
  for (const w of report.workspaces) {
    if (!w.projectId || !w.workspaceId) continue
    idsByProject.set(w.projectId, [...(idsByProject.get(w.projectId) ?? []), w.workspaceId])
  }
  const agentsByProject = new Map(await Promise.all(
    rowProjectIds.map(async (projectId) =>
      [projectId, await getProjectAgentSessions(projectId, idsByProject.get(projectId) ?? [])] as const),
  ))
  const agentsFor = (w: WorkspaceRuntimeReport): AgentSessionLinkRow[] =>
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
      prompt: links[0]?.firstPrompt,
      title: row?.title,
      groupId: row?.groupId,
      ...(row !== undefined ? { permissionMode: row.permissionMode } : {}),
    }
    if (w.phase === 'terminating') {
      // Non-interactive placeholder: no ports, and `running` so no attention
      // badge fires. Conversations are kept only to show the model.
      return {
        ...base,
        status: 'running',
        stopping: true,
        agentSessions: links.map((l) => toAgentSessionEntry(l)),
        blockedHosts: [],
        forwardedPorts: [],
        unforwardedPorts: [],
      }
    }
    return {
      ...base,
      ...listedStatus(w.status),
      ...(w.waitingSinceMs !== undefined ? { waitingSinceMs: w.waitingSinceMs } : {}),
      agentSessions: links.map((l) => toAgentSessionEntry(l, liveStatus(w.agents, l))),
      ...(w.terminals !== undefined ? { terminals: w.terminals } : {}),
      blockedHosts: w.blockedHosts,
      forwardedPorts: w.forwardedPorts,
      unforwardedPorts: w.unforwardedPorts,
      baseBranch: row?.baseBranch,
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
  l: AgentSessionLinkRow,
): { status: AgentStatus; waitingSinceMs?: number } | undefined {
  if (!l.active || l.paneId === undefined) return undefined
  const agent = agents.find((a) => a.handle === l.paneId)
  if (agent === undefined) return undefined
  return {
    status: agent.status,
    ...(agent.waitingSinceMs !== undefined ? { waitingSinceMs: agent.waitingSinceMs } : {}),
  }
}
