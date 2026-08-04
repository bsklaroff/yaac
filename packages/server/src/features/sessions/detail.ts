import { findSessionPod, listSessionPods } from '#platform/k8s'
import { getVclusterStatus, type VclusterStatus } from '#features/cluster'
import { ServerError } from '@yaac/shared/errors'
import { getAgentSessionFirstMessage, normalizeTool } from '#features/agents'
import { firstAgentSession } from './agent-session-store'
import { readBlockedHosts } from '#features/egress'
import { readGitAuthFailures } from '#features/projects'
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

interface MatchedSession {
  jobName: string
  sessionId: string
  projectSlug: string
  state: string
  tool: AgentTool
  labels: Record<string, string>
  createdAt: string
}

async function findSession(idOrName: string): Promise<MatchedSession> {
  let pods
  try {
    pods = await listSessionPods()
  } catch (err) {
    throw new ServerError('RUNTIME_UNAVAILABLE', err instanceof Error ? err.message : String(err))
  }
  const match = findSessionPod(pods, idOrName)
  if (!match) throw new ServerError('NOT_FOUND', `session ${idOrName} not found`)
  return {
    jobName: match.jobName,
    sessionId: match.sessionId,
    projectSlug: match.projectSlug,
    state: match.running ? 'running' : match.phase.toLowerCase(),
    tool: normalizeTool(match.tool),
    labels: match.labels,
    createdAt: new Date(match.createdAtMs).toISOString(),
  }
}

export async function getSessionDetail(idOrName: string): Promise<SessionDetail> {
  const match = await findSession(idOrName)
  const blocked = match.sessionId
    ? await readBlockedHosts(match.sessionId)
    : []
  const gitAuthFailures = match.projectSlug
    ? await readGitAuthFailures(match.projectSlug)
    : []
  // Best-effort: detail must render even when the vcluster lookup
  // hiccups (it is one extra kubectl get; null for non-vcluster sessions).
  const vcluster = await getVclusterStatus(match.sessionId).catch(() => null)
  return {
    sessionId: match.sessionId,
    projectSlug: match.projectSlug,
    jobName: match.jobName,
    state: match.state,
    tool: match.tool,
    labels: match.labels,
    blockedHostsCount: blocked.length,
    gitAuthFailures,
    createdAt: match.createdAt,
    ...(vcluster ? { virtualCluster: vcluster } : {}),
  }
}

export async function getSessionBlockedHosts(idOrName: string): Promise<string[]> {
  const match = await findSession(idOrName)
  if (!match.sessionId) return []
  return readBlockedHosts(match.sessionId)
}

export async function getSessionPrompt(idOrName: string): Promise<string | undefined> {
  const match = await findSession(idOrName)
  if (!match.sessionId || !match.projectSlug) return undefined
  // The captured prompt first: for opencode the live lookup is an exec into
  // the pod, and this route can be polled, so a repeat caller must not cost
  // one kubectl-exec each. Falls back to the live read for a session the
  // capture step hasn't reached yet.
  const first = await firstAgentSession(match.projectSlug, match.sessionId).catch(() => undefined)
  if (first?.firstPrompt !== undefined) return first.firstPrompt
  // Fall back to the transcript the conversation recorded, not to a path
  // derived from the worktree id — codex's rollout name is underivable, and
  // the recorded path is the only handle on it.
  return getAgentSessionFirstMessage(first?.tool ?? match.tool, first?.transcriptPath, match.jobName)
}
