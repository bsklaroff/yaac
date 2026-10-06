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

export async function ensureProjectExists(slug: string): Promise<void> {
  if (!await getProjectRow(slug)) {
    throw new ServerError('NOT_FOUND', `project ${slug} not found`)
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
  const rowSlugs = [...new Set(report.workspaces.map((w) => w.projectSlug).filter((v) => !!v))]
  const rowsBySlug = new Map(await Promise.all(
    rowSlugs.map(async (slug) => [slug, await getProjectWorkspaceRows(slug)] as const),
  ))
  const rowFor = (w: WorkspaceRuntimeReport): WorkspaceRow | undefined =>
    w.projectSlug && w.workspaceId ? rowsBySlug.get(w.projectSlug)?.get(w.workspaceId) : undefined

  const idsBySlug = new Map<string, string[]>()
  for (const w of report.workspaces) {
    if (!w.projectSlug || !w.workspaceId) continue
    idsBySlug.set(w.projectSlug, [...(idsBySlug.get(w.projectSlug) ?? []), w.workspaceId])
  }
  const agentsBySlug = new Map(await Promise.all(
    rowSlugs.map(async (slug) =>
      [slug, await getProjectAgentSessions(slug, idsBySlug.get(slug) ?? [])] as const),
  ))
  const agentsFor = (w: WorkspaceRuntimeReport): AgentSessionLinkRow[] =>
    (w.projectSlug && w.workspaceId
      ? agentsBySlug.get(w.projectSlug)?.get(w.workspaceId)
      : undefined) ?? []

  const workspaces = report.workspaces.map((w): WorkspaceListEntry => {
    const row = rowFor(w)
    const links = agentsFor(w)
    const base = {
      workspaceId: w.workspaceId,
      projectSlug: w.projectSlug,
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
