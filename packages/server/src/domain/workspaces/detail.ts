import { ServerError } from '@yaac/shared/errors'
import { firstAgentSession } from '#db'
import { recordedTranscript } from './agent-session-paths'
import { workspaceForkBranch } from './fork-branch'
import { resolveWorkspaceContainer, resolveWorkspaceId, resolveWorkspaceRecord } from './resolve'
import { getAgentSessionFirstMessage } from '#runtime/agents'
import { workspaceDriver } from '#drivers/driver'
import { CHANGES_BASE_UNRESOLVED, WorkspaceExecError } from '#drivers/contract'
import type { RuntimeHandle } from '#drivers/contract'
import type { AgentTool, GitAuthFailure, WorkspaceChanges } from '@yaac/shared/types'

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

/**
 * The working-tree diff of a running workspace.
 *
 * An explicit `base` wins; otherwise the default is the recorded fork
 * branch (`workspaceForkBranch`). Relying on `@{upstream}` instead would
 * show no changes once the agent pushes its branch, since the upstream then
 * points at HEAD.
 *
 * `diff: false` leaves the diff body out, for callers that show only the
 * file list and line counts.
 *
 * Only an unresolvable explicit `base` becomes a VALIDATION error. Other
 * failures, including an unresolvable recorded fork branch, stay faults.
 */
export async function getWorkspaceChanges(
  idOrPrefix: string,
  base?: string,
  diff = true,
): Promise<WorkspaceChanges> {
  const { jobName, workspaceId, projectId } = await resolveWorkspaceContainer(
    idOrPrefix, { requireRunning: true },
  )
  const forkBranch = await workspaceForkBranch(projectId, workspaceId)
  // The runtime treats a blank `base` as unset.
  const named = base?.trim()
  try {
    return await workspaceDriver().changes(jobName, base, forkBranch ?? undefined, diff)
  } catch (err) {
    if (named && err instanceof WorkspaceExecError && err.code === CHANGES_BASE_UNRESOLVED) {
      // The ref may exist but share no history with the workspace.
      throw new ServerError(
        'VALIDATION', `base ref "${named}" gives no diff base in this workspace`,
      )
    }
    throw err
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
