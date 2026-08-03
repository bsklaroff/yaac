import { findSessionPod, listSessionPods } from '#platform/k8s/pods'
import { cleanupSession } from '#features/sessions/cleanup'
import { clearSessionDeleted, findSessionRow } from '#features/sessions/store'
import { clearSessionTerminating, normalizeTool } from '#features/sessions/state'
import { createSession, type SessionCreateResult } from '#features/sessions/create'
import { ServerError } from '@yaac/shared/errors'
import type { AgentTool } from '@yaac/shared/types'

export interface RestartResolution {
  projectSlug: string
  sessionId: string
  tool: AgentTool
  jobName: string | null
}

/**
 * Locate the project + tool for a session id or id prefix. Prefers a live
 * pod's labels (authoritative about tool) and falls back to the recorded
 * session row, so a deleted session can still be restarted against its
 * saved worktree and history.
 */
export async function resolveRestartTarget(idOrName: string): Promise<RestartResolution> {
  try {
    const pods = await listSessionPods()
    const match = findSessionPod(pods, idOrName)
    if (match) {
      return {
        projectSlug: match.projectSlug,
        sessionId: match.sessionId,
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

  const row = await findSessionRow(idOrName)
  if (row) {
    return {
      projectSlug: row.projectSlug,
      sessionId: row.sessionId,
      tool: row.tool,
      jobName: null,
    }
  }

  throw new ServerError(
    'NOT_FOUND',
    `No session found matching "${idOrName}". Run "yaac session list -d" to see deleted sessions.`,
  )
}

export interface RestartSessionOptions {
  gitUser?: { name: string; email: string }
  onProgress?: (message: string) => void
}

/**
 * Tear down any existing Job for `idOrName` (preserving the worktree)
 * and spin up a fresh one that resumes the same session via
 * `claude --resume` / `codex resume`. All env, config, proxy rules, and
 * port forwarders come from the project config.
 */
export async function restartSession(
  idOrName: string,
  opts: RestartSessionOptions = {},
): Promise<SessionCreateResult> {
  const { projectSlug, sessionId, tool, jobName } = await resolveRestartTarget(idOrName)

  if (jobName) {
    opts.onProgress?.(`Stopping session job ${jobName}...`)
    await cleanupSession({ jobName, projectSlug, sessionId })
  }

  // A restart reuses the session id, so drop any terminating mark left by the
  // cleanup above (or an earlier teardown) before the fresh pod comes up —
  // otherwise the new session would render as "terminating…".
  clearSessionTerminating(sessionId)

  const result = await createSession(projectSlug, {
    resume: true,
    sessionId,
    tool,
    gitUser: opts.gitUser,
    onProgress: opts.onProgress,
  })

  // The session lives again — drop its deletion record (and any death cause
  // from its previous life) so the deleted view can't show it as died. Only
  // after createSession succeeds: a failed restart leaves the record intact.
  await clearSessionDeleted(projectSlug, sessionId)

  return result
}
