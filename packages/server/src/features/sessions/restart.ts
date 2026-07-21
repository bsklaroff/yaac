import fs from 'node:fs/promises'
import path from 'node:path'
import { findSessionPod, listSessionPods } from '#platform/k8s/pods'
import {
  claudeDir,
  codexTranscriptDir,
  getProjectsDir,
  worktreesDir,
} from '@yaac/shared/project-paths'
import { cleanupSession } from '#features/sessions/cleanup'
import { clearSessionDeleted } from '#features/sessions/deleted-store'
import { clearSessionTerminating } from '#features/sessions/terminating'
import { hasOpencodeMeta } from '#features/sessions/agents/opencode-status'
import { hasPiSessionLog } from '#features/sessions/agents/pi-status'
import { normalizeTool } from '#features/sessions/status'
import { createSession, type SessionCreateResult } from '#features/sessions/create'
import { ServerError } from '@yaac/shared/errors'
import type { AgentTool } from '@yaac/shared/types'

export interface RestartResolution {
  projectSlug: string
  sessionId: string
  tool: AgentTool
  jobName: string | null
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/**
 * Pick the tool for a reaped session by looking at which per-tool artifact
 * survived: claude/codex/pi leave a JSONL log, opencode leaves a meta
 * snapshot keyed by session id. Prefers claude when several exist
 * (shouldn't happen — a session is created with a single tool) so the
 * resume path has deterministic fallback behaviour.
 */
async function detectToolFromTranscript(slug: string, sessionId: string): Promise<AgentTool> {
  const claudeJsonl = path.join(claudeDir(slug), 'projects', '-workspace', `${sessionId}.jsonl`)
  if (await fileExists(claudeJsonl)) return 'claude'
  const codexJsonl = path.join(codexTranscriptDir(slug), `${sessionId}.jsonl`)
  if (await fileExists(codexJsonl)) return 'codex'
  if (await hasPiSessionLog(slug, sessionId)) return 'pi'
  if (await hasOpencodeMeta(slug, sessionId)) return 'opencode'
  return 'claude'
}

/**
 * Locate the project + tool for a session id. Prefers a live pod's
 * labels (authoritative about tool) and falls back to scanning preserved
 * worktree dirs and transcript files so deleted sessions can still be
 * restarted against their saved history.
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
    // Cluster unreachable — try filesystem fallback. If both paths fail we
    // surface NOT_FOUND below; RUNTIME_UNAVAILABLE would be misleading
    // since the restart may still succeed when the cluster recovers by the
    // time createSession runs.
  }

  let slugs: string[] = []
  try {
    slugs = await fs.readdir(getProjectsDir())
  } catch {
    slugs = []
  }

  for (const slug of slugs) {
    let entries: string[]
    try {
      entries = await fs.readdir(worktreesDir(slug))
    } catch {
      continue
    }
    const wt = entries.find((e) => e === idOrName || e.startsWith(idOrName))
    if (!wt) continue
    const tool = await detectToolFromTranscript(slug, wt)
    return { projectSlug: slug, sessionId: wt, tool, jobName: null }
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
