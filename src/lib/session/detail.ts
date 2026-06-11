import { findSessionPod, listSessionPods } from '@/lib/k8s/pods'
import { DaemonError } from '@/daemon/errors'
import { getSessionFirstMessage, normalizeTool } from '@/lib/session/status'
import { readBlockedHosts } from '@/lib/session/blocked-hosts'
import type { AgentTool } from '@/shared/types'

export interface SessionDetail {
  sessionId: string
  projectSlug: string
  jobName: string
  state: string
  tool: AgentTool
  labels: Record<string, string>
  blockedHostsCount: number
  /** ISO timestamp of pod creation. */
  createdAt: string
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
    throw new DaemonError('RUNTIME_UNAVAILABLE', err instanceof Error ? err.message : String(err))
  }
  const match = findSessionPod(pods, idOrName)
  if (!match) throw new DaemonError('NOT_FOUND', `session ${idOrName} not found`)
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
  return {
    sessionId: match.sessionId,
    projectSlug: match.projectSlug,
    jobName: match.jobName,
    state: match.state,
    tool: match.tool,
    labels: match.labels,
    blockedHostsCount: blocked.length,
    createdAt: match.createdAt,
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
  return getSessionFirstMessage(match.projectSlug, match.sessionId, match.tool, match.jobName)
}
