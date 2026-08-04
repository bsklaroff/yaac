import { findSessionPod, listSessionPods } from '#platform/k8s'
import { cleanupSession } from '#features/sessions/cleanup'
import { clearWorktreeStopped, findWorktreeRow } from '#features/sessions/worktree-store'
import {
  firstAgentSession,
  listActiveAgentSessions,
} from '#features/sessions/agent-session-store'
import { clearSessionTerminating, normalizeTool } from '#features/sessions/state'
import { createSession, type SessionCreateResult } from '#features/sessions/create'
import { ServerError } from '@yaac/shared/errors'
import type { AgentTool } from '@yaac/shared/types'

export interface RestartResolution {
  projectSlug: string
  worktreeId: string
  tool: AgentTool
  jobName: string | null
}

/**
 * Locate the project + tool for a worktree id or id prefix. Prefers a live
 * pod's labels (authoritative about tool) and falls back to the recorded
 * worktree row, so a stopped worktree can still be restarted against its
 * saved checkout and history.
 */
export async function resolveRestartTarget(idOrName: string): Promise<RestartResolution> {
  try {
    const pods = await listSessionPods()
    const match = findSessionPod(pods, idOrName)
    if (match) {
      return {
        projectSlug: match.projectSlug,
        worktreeId: match.sessionId,
        tool: normalizeTool(match.tool),
        jobName: match.jobName,
      }
    }
  } catch {
    // Cluster unreachable — try the recorded row. If both paths fail we
    // surface NOT_FOUND below; RUNTIME_UNAVAILABLE would be misleading
    // since the restart may still succeed when the cluster recovers by the
    // time createSession runs.
  }

  const row = await findWorktreeRow(idOrName)
  if (row) {
    // The tool is the first conversation's — a worktree has none of its own.
    // A worktree with no conversation recorded cannot say what to launch, so
    // it falls back to claude rather than refusing to restart.
    const first = await firstAgentSession(row.projectSlug, row.worktreeId)
    return {
      projectSlug: row.projectSlug,
      worktreeId: row.worktreeId,
      tool: first?.tool ?? 'claude',
      jobName: null,
    }
  }

  throw new ServerError(
    'NOT_FOUND',
    `No worktree found matching "${idOrName}". Run "yaac worktree list -s" to see stopped worktrees.`,
  )
}

export interface RestartWorktreeOptions {
  gitUser?: { name: string; email: string }
  onProgress?: (message: string) => void
}

/**
 * Tear down any existing Job for `idOrName` (preserving the git worktree) and
 * spin up a fresh one that resumes the agent sessions which were live when
 * the worktree stopped — each in its own window, in the order they were
 * first opened. All env, config, proxy rules, and port forwarders come from
 * the project config.
 *
 * The active set is read, not recomputed: teardown deliberately leaves
 * `worktree_agent_sessions.active` frozen at the pod's last observed state,
 * and that freeze is the whole point — a worktree stopped with two agents
 * running comes back with two, and one whose second agent was closed first
 * comes back with one.
 */
export async function restartWorktree(
  idOrName: string,
  opts: RestartWorktreeOptions = {},
): Promise<SessionCreateResult> {
  const { projectSlug, worktreeId, tool, jobName } = await resolveRestartTarget(idOrName)

  if (jobName) {
    opts.onProgress?.(`Stopping session job ${jobName}...`)
    await cleanupSession({ jobName, projectSlug, sessionId: worktreeId })
  }

  // A restart reuses the worktree id, so drop any terminating mark left by the
  // cleanup above (or an earlier teardown) before the fresh pod comes up —
  // otherwise the new session would render as "stopping…".
  clearSessionTerminating(worktreeId)

  // Each conversation resumes under its OWN tool: a worktree can hold a
  // codex conversation next to claude ones, and launching the wrong binary
  // against an id it does not know kills the pane.
  const resume = (await listActiveAgentSessions(projectSlug, worktreeId).catch(() => []))
    .map((l) => ({ agentSessionId: l.agentSessionId, tool: l.tool }))
  if (resume.length > 1) opts.onProgress?.(`Restoring ${resume.length} agent sessions...`)

  const result = await createSession(projectSlug, {
    // Always reuse the checkout — that is what a restart *is*. Clearing this
    // would send the create down `git worktree add` against a checkout that
    // is still there, fail, and roll the worktree row away with it.
    resume: true,
    sessionId: worktreeId,
    tool,
    resumeAgentSessions: resume,
    gitUser: opts.gitUser,
    onProgress: opts.onProgress,
  })

  // The worktree lives again — drop its stop record (and any death cause
  // from its previous life) so the stopped view can't show it as died. Only
  // after createSession succeeds: a failed restart leaves the record intact.
  await clearWorktreeStopped(projectSlug, worktreeId)

  return result
}
