import { ServerError } from '@yaac/shared/errors'
import { firstAgentSession } from '#features/records'
import { getAgentSessionFirstMessage } from '#runtime/agents'
import { readBlockedHosts } from '#runtime/k8s/egress'
import { readGitAuthFailures } from '#features/projects'
import { getVclusterStatus, type VclusterStatus } from '#runtime/k8s/cluster'
import { findWorkspace } from '#runtime/k8s/worktrees'
import type { RuntimeHandle } from '#runtime/contract'
import type { AgentTool, GitAuthFailure } from '@yaac/shared/types'

export interface WorktreeDetail {
  worktreeId: string
  projectSlug: string
  jobName: string
  state: string
  tool: AgentTool
  labels: Record<string, string>
  blockedHostsCount: number
  /** Git credentials the upstream rejected for this worktree's project
   *  (expired/revoked token) — project-wide, shared by all its worktrees. */
  gitAuthFailures: GitAuthFailure[]
  /** ISO timestamp of pod creation. */
  createdAt: string
  /** Present only for virtualCluster worktrees. */
  virtualCluster?: VclusterStatus
}

async function findWorktree(idOrName: string): Promise<RuntimeHandle> {
  const match = await findWorkspace(idOrName)
  if (!match) throw new ServerError('NOT_FOUND', `session ${idOrName} not found`)
  return match
}

export async function getWorktreeDetail(idOrName: string): Promise<WorktreeDetail> {
  const match = await findWorktree(idOrName)
  const blocked = match.workspaceId
    ? await readBlockedHosts(match.workspaceId)
    : []
  const gitAuthFailures = match.projectSlug
    ? await readGitAuthFailures(match.projectSlug)
    : []
  // Best-effort: detail must render even when the vcluster lookup
  // hiccups (it is one extra cluster read; null for non-vcluster worktrees).
  const vcluster = await getVclusterStatus(match.workspaceId).catch(() => null)
  return {
    worktreeId: match.workspaceId,
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

export async function getWorktreeBlockedHosts(idOrName: string): Promise<string[]> {
  const match = await findWorktree(idOrName)
  if (!match.workspaceId) return []
  return readBlockedHosts(match.workspaceId)
}

export async function getWorktreePrompt(idOrName: string): Promise<string | undefined> {
  const match = await findWorktree(idOrName)
  if (!match.workspaceId || !match.projectSlug) return undefined
  // The captured prompt first: for opencode the live lookup is an exec into
  // the pod, and this route can be polled, so a repeat caller must not cost
  // one of those each. Falls back to the live read for a worktree the capture
  // step hasn't reached yet.
  const first = await firstAgentSession(match.projectSlug, match.workspaceId).catch(() => undefined)
  if (first?.firstPrompt !== undefined) return first.firstPrompt
  // Fall back to the transcript the conversation recorded, not to a path
  // derived from the worktree id — codex's rollout name is underivable, and
  // the recorded path is the only handle on it.
  return getAgentSessionFirstMessage(first?.tool ?? match.tool, first?.transcriptPath, match.jobName)
}
