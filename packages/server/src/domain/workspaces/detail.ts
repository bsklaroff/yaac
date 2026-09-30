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
  projectSlug: string
  jobName: string
  state: string
  tool: AgentTool
  labels: Record<string, string>
  blockedHostsCount: number
  /** Git credentials the upstream rejected for this workspace's project
   *  (expired/revoked token) — project-wide, shared by all its workspaces. */
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
  const gitAuthFailures = match.projectSlug
    ? await runtime.gitAuthFailures(match.projectSlug)
    : []
  return {
    workspaceId: match.workspaceId,
    projectSlug: match.projectSlug,
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
 * The default base is the branch the workspace forked from — its recorded
 * base, the same source as the status bar above its panes — and choosing it
 * here is the substance rather than a detail. Left to the runtime's own default,
 * the diff collapses to nothing once the agent renames and pushes its
 * branch: the current branch's `@{upstream}` then resolves to itself, and
 * the merge-base with it is HEAD. Passing the fork point keeps committed
 * work visible for exactly as long as it is unmerged.
 *
 * An explicit `base` from the caller wins; the fork branch is looked up
 * only as the fallback, and is cached because this is polled.
 *
 * Naming the base is also what makes an unresolvable one this caller's
 * mistake, so translating that failure is this verb's job: it is the one
 * place that knows the ref came from the request. Both qualifiers on the
 * mapping are load-bearing. Any other exec failure stays a fault — a bare
 * nonzero exit is not evidence of a bad ref, and a workspace with no
 * checkout is not the caller's doing. And with no explicit `base` the ref
 * came from the recorded fork branch instead, where an unresolvable one is
 * an inconsistency of ours and blaming the caller for it would hide it.
 */
export async function getWorkspaceChanges(
  idOrPrefix: string,
  base?: string,
): Promise<WorkspaceChanges> {
  const { jobName, workspaceId, projectSlug } = await resolveWorkspaceContainer(
    idOrPrefix, { requireRunning: true },
  )
  const forkBranch = await workspaceForkBranch(projectSlug, workspaceId)
  // Trimmed, because that is what the runtime does with it: a blank `base`
  // selects the default path pod-side, so it names no ref to blame.
  const named = base?.trim()
  try {
    return await workspaceDriver().changes(jobName, base, forkBranch ?? undefined)
  } catch (err) {
    if (named && err instanceof WorkspaceExecError && err.code === CHANGES_BASE_UNRESOLVED) {
      // "no diff base" rather than "no such ref": the ref may exist and
      // simply share no history with this workspace, which is just as
      // unusable a base and just as much the caller's to fix.
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
 * The founding ask of a workspace's first conversation.
 *
 * Resolved from the RECORD, not from a container: the prompt is recorded
 * state — a captured row, or a transcript on the host — so a stopped
 * workspace still has one, and that is exactly when it is asked for (the
 * stopped list is what you read before restarting). Only the opencode
 * fallback needs a live workspace, and it simply has nothing to read when
 * there is none.
 */
export async function getWorkspacePrompt(idOrPrefix: string): Promise<string | undefined> {
  const { projectSlug, workspaceId, jobName, tool } = await resolveWorkspaceRecord(idOrPrefix)
  if (!workspaceId || !projectSlug) return undefined
  // The captured prompt first: for opencode the live lookup is an exec into
  // the pod, and this route can be polled, so a repeat caller must not cost
  // one of those each. Falls back to the live read for a workspace the capture
  // step hasn't reached yet.
  const first = await firstAgentSession(projectSlug, workspaceId).catch(() => undefined)
  if (first?.firstPrompt !== undefined) return first.firstPrompt
  const which = first?.tool ?? tool
  if (which === undefined) return undefined
  // Fall back to the transcript the conversation recorded, not to a path
  // derived from the workspace id — codex's rollout name is underivable, and
  // the recorded path is the only handle on it.
  return getAgentSessionFirstMessage(which, recordedTranscript(first), jobName, first?.agentSessionId)
}
