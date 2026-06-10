import fs from 'node:fs/promises'
import path from 'node:path'
import { podman } from '@/lib/container/runtime'
import {
  claudeDir,
  codexTranscriptDir,
  getDataDir,
  getProjectsDir,
  opencodeMetaFile,
  worktreesDir,
} from '@/lib/project/paths'
import { cleanupSession } from '@/lib/session/cleanup'
import { getToolFromContainer } from '@/lib/session/status'
import { createSession, type SessionCreateResult } from '@/daemon/session-create'
import { loadPlanSessionMeta } from '@/lib/plans/session-meta'
import { sessionPlansDir } from '@/lib/project/paths'
import { DaemonError } from '@/daemon/errors'
import type { AgentTool } from '@/shared/types'

export interface RestartResolution {
  projectSlug: string
  sessionId: string
  tool: AgentTool
  containerName: string | null
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
 * Locate the project + tool for a session id. Prefers a live container's
 * labels (authoritative about tool) and falls back to scanning preserved
 * worktree dirs and transcript files so deleted sessions can still be
 * restarted against their saved history.
 */
export async function resolveRestartTarget(idOrName: string): Promise<RestartResolution> {
  try {
    const containers = await podman.listContainers({
      all: true,
      filters: { label: [`yaac.data-dir=${getDataDir()}`] },
    })
    const match = containers.find((c) => {
      const sid = c.Labels?.['yaac.session-id'] ?? ''
      const name = c.Names?.[0]?.replace(/^\//, '') ?? ''
      return sid === idOrName
        || name === idOrName
        || sid.startsWith(idOrName)
        || c.Id.startsWith(idOrName)
    })
    if (match) {
      return {
        projectSlug: match.Labels?.['yaac.project'] ?? '',
        sessionId: match.Labels?.['yaac.session-id'] ?? '',
        tool: getToolFromContainer(match),
        containerName: match.Names?.[0]?.replace(/^\//, '') ?? match.Id,
      }
    }
  } catch {
    // Podman unavailable — try filesystem fallback. If both paths fail we
    // surface NOT_FOUND below; PODMAN_UNAVAILABLE would be misleading since
    // the restart may still succeed when podman recovers by the time
    // createSession runs.
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
    return { projectSlug: slug, sessionId: wt, tool, containerName: null }
  }

  throw new DaemonError(
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
 * Tear down any existing container for `idOrName` (preserving the
 * worktree) and spin up a fresh one that resumes the same session via
 * `claude --resume` / `codex resume`. All env, config, proxy rules, and
 * port forwarders come from the project config — addDir / addDirRw are
 * the only per-invocation inputs because they're not persisted anywhere.
 */
export async function restartSession(
  idOrName: string,
  opts: RestartSessionOptions = {},
): Promise<SessionCreateResult> {
  const { projectSlug, sessionId, tool, containerName } = await resolveRestartTarget(idOrName)

  if (containerName) {
    opts.onProgress?.(`Stopping container ${containerName}...`)
    await cleanupSession({ containerName, projectSlug, sessionId })
  }

  // Plan-mode sessions get their wiki clone re-mounted at /plans (no new
  // seed prompt — the resumed transcript already carries it).
  const planMeta = await loadPlanSessionMeta(projectSlug, sessionId)
  const plansDir = sessionPlansDir(projectSlug, sessionId)
  const plansDirExists = await fileExists(path.join(plansDir, '.git'))

  const result = await createSession(projectSlug, {
    resume: true,
    sessionId,
    tool,
    addDir: opts.addDir,
    addDirRw: opts.addDirRw,
    gitUser: opts.gitUser,
    onProgress: opts.onProgress,
    ...(planMeta && plansDirExists
      ? { plans: { role: planMeta.role, doc: planMeta.doc, hostDir: plansDir } }
      : {}),
  })
  if (!result) throw new DaemonError('INTERNAL', 'session restart returned no result')
  return result
}
