import { ServerError } from '@yaac/shared/errors'
import { firstAgentSession } from '#db'
import { recordedTranscript } from './agent-session-paths'
import { resolveWorkspaceId, resolveWorkspaceRecord } from './resolve'
import { getAgentSessionFirstMessage } from '#runtime/agents'
import { workspaceDriver } from '#drivers/driver'
import type { RuntimeHandle } from '#drivers/contract'
import type { AgentTool, GitAuthFailure } from '@yaac/shared/types'

export interface WorkspaceDetail {
  workspaceId: string
  projectId: string
  jobName: string
  state: string
  tool: AgentTool
  labels: Record<string, string>
  blockedHostsCount: number
  /** Git credentials rejected upstream for this workspace's project. */
  gitAuthFailures: GitAuthFailure[]
  /** ISO timestamp of pod creation. */
  createdAt: string
}

async function findWorkspace(idOrPrefix: string): Promise<RuntimeHandle> {
  const match = await workspaceDriver().find(await resolveWorkspaceId(idOrPrefix))
  if (!match) throw new ServerError('NOT_FOUND', `session ${idOrPrefix} not found`)
  return match
}

export async function getWorkspaceDetail(idOrPrefix: string): Promise<WorkspaceDetail> {
  const runtime = workspaceDriver()
  const match = await findWorkspace(idOrPrefix)
  const blocked = match.workspaceId
    ? await runtime.blockedHosts(match.workspaceId)
    : []
  const gitAuthFailures = match.projectId
    ? (await runtime.gitAuthFailures())[match.projectId] ?? []
    : []
  return {
    workspaceId: match.workspaceId,
    projectId: match.projectId,
    jobName: match.jobName,
    state: match.state,
    tool: match.tool,
    labels: match.labels,
    blockedHostsCount: blocked.length,
    gitAuthFailures,
    createdAt: new Date(match.createdAtMs).toISOString(),
  }
}

export async function getWorkspaceBlockedHosts(idOrPrefix: string): Promise<string[]> {
  const match = await findWorkspace(idOrPrefix)
  if (!match.workspaceId) return []
  return workspaceDriver().blockedHosts(match.workspaceId)
}

/**
 * The first prompt of a workspace's first conversation. Read from recorded
 * state (row or host transcript), so it works for stopped workspaces; only
 * the opencode fallback needs a running one.
 */
export async function getWorkspacePrompt(idOrPrefix: string): Promise<string | undefined> {
  const { projectId, workspaceId, jobName, tool } = await resolveWorkspaceRecord(idOrPrefix)
  if (!workspaceId || !projectId) return undefined
  // Prefer the captured row: this route is polled, and the opencode lookup
  // costs an exec.
  const first = await firstAgentSession(projectId, workspaceId).catch(() => undefined)
  if (first?.firstPrompt !== undefined) return first.firstPrompt
  const which = first?.tool ?? tool
  if (which === undefined) return undefined
  // Use the recorded transcript path; codex's rollout name cannot be derived.
  return getAgentSessionFirstMessage(which, recordedTranscript(first), jobName, first?.agentSessionId)
}
