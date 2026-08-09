import { herd, type WorkspaceHandle } from '#herd'
import { ServerError } from '@yaac/shared/errors'
import { firstAgentSession } from '#features/records'
import type { VclusterStatus } from '#features/cluster'
import type { AgentTool, GitAuthFailure } from '@yaac/shared/types'

export interface SessionDetail {
  sessionId: string
  projectSlug: string
  jobName: string
  state: string
  tool: AgentTool
  labels: Record<string, string>
  blockedHostsCount: number
  /** Git credentials the upstream rejected for this session's project
   *  (expired/revoked token) — project-wide, shared by all its sessions. */
  gitAuthFailures: GitAuthFailure[]
  /** ISO timestamp of pod creation. */
  createdAt: string
  /** Present only for virtualCluster sessions. */
  virtualCluster?: VclusterStatus
}

async function findSession(idOrName: string): Promise<WorkspaceHandle> {
  const match = await herd().workspaces.find(idOrName)
  if (!match) throw new ServerError('NOT_FOUND', `session ${idOrName} not found`)
  return match
}

export async function getSessionDetail(idOrName: string): Promise<SessionDetail> {
  const match = await findSession(idOrName)
  const blocked = match.workspaceId
    ? await herd().workspaces.blockedHosts(match.workspaceId)
    : []
  const gitAuthFailures = match.projectSlug
    ? await herd().projects.gitAuthFailures(match.projectSlug)
    : []
  // Best-effort: detail must render even when the vcluster lookup
  // hiccups (it is one extra cluster read; null for non-vcluster sessions).
  const vcluster = await herd().workspaces.vclusterStatus(match.workspaceId).catch(() => null)
  return {
    sessionId: match.workspaceId,
    projectSlug: match.projectSlug,
    jobName: match.jobName,
    state: match.state,
    tool: match.tool,
    labels: match.labels,
    blockedHostsCount: blocked.length,
    gitAuthFailures,
    createdAt: new Date(match.createdAtMs).toISOString(),
    ...(vcluster ? { virtualCluster: vcluster } : {}),
  }
}

export async function getSessionBlockedHosts(idOrName: string): Promise<string[]> {
  const match = await findSession(idOrName)
  if (!match.workspaceId) return []
  return herd().workspaces.blockedHosts(match.workspaceId)
}

export async function getSessionPrompt(idOrName: string): Promise<string | undefined> {
  const match = await findSession(idOrName)
  if (!match.workspaceId || !match.projectSlug) return undefined
  // The captured prompt first: for opencode the live lookup is an exec into
  // the pod, and this route can be polled, so a repeat caller must not cost
  // one of those each. Falls back to the live read for a session the capture
  // step hasn't reached yet.
  const first = await firstAgentSession(match.projectSlug, match.workspaceId).catch(() => undefined)
  if (first?.firstPrompt !== undefined) return first.firstPrompt
  // Fall back to the transcript the conversation recorded, not to a path
  // derived from the worktree id — codex's rollout name is underivable, and
  // the recorded path is the only handle on it.
  return herd().agents.firstMessage(first?.tool ?? match.tool, first?.transcriptPath, match.jobName)
}
