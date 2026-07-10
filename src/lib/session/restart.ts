import fs from 'node:fs/promises'
import path from 'node:path'
import { findSessionPod, listSessionPods } from '@/lib/k8s/pods'
import {
  claudeDir,
  codexTranscriptDir,
  getProjectsDir,
  opencodeMetaFile,
  worktreesDir,
} from '@/shared/project-paths'
import { cleanupSession } from '@/lib/session/cleanup'
import { normalizeTool } from '@/lib/session/status'
import { createSession, type SessionCreateResult } from '@/server/session-create'
import { ServerError } from '@/shared/errors'
import type { AgentTool } from '@/shared/types'

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
 * survived: claude/codex leave a transcript jsonl, opencode leaves a meta
 * snapshot keyed by session id. Prefers claude when several exist
 * (shouldn't happen — a session is created with a single tool) so the
 * resume path has deterministic fallback behaviour.
 */
async function detectToolFromTranscript(slug: string, sessionId: string): Promise<AgentTool> {
  const claudeJsonl = path.join(claudeDir(slug), 'projects', '-workspace', `${sessionId}.jsonl`)
  if (await fileExists(claudeJsonl)) return 'claude'
  const codexJsonl = path.join(codexTranscriptDir(slug), `${sessionId}.jsonl`)
  if (await fileExists(codexJsonl)) return 'codex'
  if (await fileExists(opencodeMetaFile(slug, sessionId))) return 'opencode'
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
  addDir?: string[]
  addDirRw?: string[]
  gitUser?: { name: string; email: string }
  onProgress?: (message: string) => void
}

/**
 * Tear down any existing Job for `idOrName` (preserving the worktree)
 * and spin up a fresh one that resumes the same session via
 * `claude --resume` / `codex resume`. All env, config, proxy rules, and
 * port forwarders come from the project config — addDir / addDirRw are
 * the only per-invocation inputs because they're not persisted anywhere.
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

  return createSession(projectSlug, {
    resume: true,
    sessionId,
    tool,
    addDir: opts.addDir,
    addDirRw: opts.addDirRw,
    gitUser: opts.gitUser,
    onProgress: opts.onProgress,
  })
}
