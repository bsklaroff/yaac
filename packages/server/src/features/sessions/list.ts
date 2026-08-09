import {
  getProjectAgentSessions,
  getProjectRow,
  getProjectWorktreeRows,
  toAgentSessionEntry,
  type AgentSessionLinkRow,
  type WorktreeRow,
} from '#features/records'
import { observeWorkspaces } from './observe'
import { ServerError } from '@yaac/shared/errors'
import { formatUtcTimestamp } from '@yaac/shared/time'
import type { AgentLiveness, WorkspaceReport } from '@yaac/shared/herd'
import type { ActiveSessionsResult, WorktreeListEntry } from '@yaac/shared/types'

export async function ensureProjectExists(slug: string): Promise<void> {
  if (!await getProjectRow(slug)) {
    throw new ServerError('NOT_FOUND', `project ${slug} not found`)
  }
}

/**
 * In-flight `listActiveSessions` calls keyed by `projectFilter ?? ''`.
 * The UI polls /session/list every ~5s; overlapping requests share one
 * execution. Each entry is cleared when its Promise settles.
 */
const listActiveInflight = new Map<string, Promise<ActiveSessionsResult>>()

/**
 * Test-only: drop in-flight state so test cases that mock different
 * underlying behavior don't see each other's shared promise.
 */
export function _clearListActiveInflightForTests(): void {
  listActiveInflight.clear()
}

/**
 * The active-session rows the renderer displays, and the stale set the caller
 * is expected to tear down.
 *
 * This is the JOIN. The herd reports what its substrate can see right now
 * (`observeWorkspaces`); everything else here is what only the server knows —
 * the title a user typed, the pin they set, the creation time that has to
 * survive a restart the runtime did not, and the conversations a workspace
 * has hosted with their opening messages. Neither half can answer alone
 * (docs/plans/herd-split.md).
 *
 * Concurrent calls with the same `projectFilter` share one in-flight
 * Promise (see `listActiveInflight`).
 */
export async function listActiveSessions(projectFilter?: string): Promise<ActiveSessionsResult> {
  const key = projectFilter ?? ''
  const existing = listActiveInflight.get(key)
  if (existing) return existing
  const promise = listActiveSessionsImpl(projectFilter).finally(() => {
    listActiveInflight.delete(key)
  })
  listActiveInflight.set(key, promise)
  return promise
}

async function listActiveSessionsImpl(projectFilter?: string): Promise<ActiveSessionsResult> {
  // Whether a project exists is the server's own record, so it is checked
  // here rather than left to a herd, which only knows what it is running.
  if (projectFilter) await ensureProjectExists(projectFilter)

  const report = await observeWorkspaces(projectFilter)

  // Recorded state — prompt, title, base branch, pin — one query per project
  // for both live and terminating workspaces (the latter keep their title and
  // pin on the way out).
  const rowSlugs = [...new Set(report.workspaces.map((w) => w.projectSlug).filter((v) => !!v))]
  const rowsBySlug = new Map(await Promise.all(
    rowSlugs.map(async (slug) => [slug, await getProjectWorktreeRows(slug)] as const),
  ))
  const rowFor = (w: WorkspaceReport): WorktreeRow | undefined =>
    w.projectSlug && w.workspaceId ? rowsBySlug.get(w.projectSlug)?.get(w.workspaceId) : undefined

  // The conversations inside each workspace, one query per project — the same
  // shape as the rows above, so a snapshot never pays per row.
  const idsBySlug = new Map<string, string[]>()
  for (const w of report.workspaces) {
    if (!w.projectSlug || !w.workspaceId) continue
    idsBySlug.set(w.projectSlug, [...(idsBySlug.get(w.projectSlug) ?? []), w.workspaceId])
  }
  const agentsBySlug = new Map(await Promise.all(
    rowSlugs.map(async (slug) =>
      [slug, await getProjectAgentSessions(slug, idsBySlug.get(slug) ?? [])] as const),
  ))
  const agentsFor = (w: WorkspaceReport): AgentSessionLinkRow[] =>
    (w.projectSlug && w.workspaceId
      ? agentsBySlug.get(w.projectSlug)?.get(w.workspaceId)
      : undefined) ?? []

  const worktrees = report.workspaces.map((w): WorktreeListEntry => {
    const row = rowFor(w)
    const links = agentsFor(w)
    const base = {
      worktreeId: w.workspaceId,
      projectSlug: w.projectSlug,
      tool: w.tool,
      // The recorded creation time, which — unlike the runtime's — survives a
      // restart. A workspace with no row yet (created by an older yaac, no
      // transcript for the backfill to find) falls back to what the herd saw.
      createdAt: formatUtcTimestamp((row?.createdAt ?? new Date(w.createdAtMs)).getTime()),
      // The founding ask is the first conversation's opening message — the
      // worktree has none of its own.
      prompt: links[0]?.firstPrompt,
      title: row?.title,
      background: row?.background || undefined,
    }
    if (w.phase === 'terminating') {
      // A distinct, non-interactive placeholder: no agents, no ports, and a
      // forced `running` so no attention badge fires on a row on its way out.
      return {
        ...base,
        status: 'running',
        stopping: true,
        agentSessions: [],
        blockedHosts: [],
        forwardedPorts: [],
        unforwardedPorts: [],
      }
    }
    return {
      ...base,
      status: w.status,
      ...(w.waitingSinceMs !== undefined ? { waitingSinceMs: w.waitingSinceMs } : {}),
      agentSessions: links.map((l) => toAgentSessionEntry(l, liveStatus(w.agents, l))),
      blockedHosts: w.blockedHosts,
      forwardedPorts: w.forwardedPorts,
      unforwardedPorts: w.unforwardedPorts,
      baseBranch: row?.baseBranch,
    }
  })

  // Project-wide git credential failures — independent of the workspace set
  // (a bad token persists with zero running sessions and blocks new ones).
  const gitAuthFailures = projectFilter
    ? (report.gitAuthFailures[projectFilter]
      ? { [projectFilter]: report.gitAuthFailures[projectFilter] }
      : {})
    : report.gitAuthFailures

  return { worktrees, stale: report.stale, gitAuthFailures }
}

/**
 * A live conversation's own busy/idle, joined onto the herd's per-handle
 * liveness by the handle this conversation was last seen on — a tmux pane id
 * under `tui`, the acpd window name under `acp`. A conversation with no live
 * handle (the worktree's history) has none, which is how a client tells
 * "still open" from "was open".
 */
function liveStatus(
  agents: AgentLiveness[],
  l: AgentSessionLinkRow,
): { status: 'running' | 'waiting'; waitingSinceMs?: number } | undefined {
  if (!l.active || l.paneId === undefined) return undefined
  const agent = agents.find((a) => a.handle === l.paneId)
  if (agent === undefined) return undefined
  return {
    status: agent.status,
    ...(agent.waitingSinceMs !== undefined ? { waitingSinceMs: agent.waitingSinceMs } : {}),
  }
}
