import fs from 'node:fs/promises'
import path from 'node:path'
import { podman } from '@/lib/container/runtime'
import { claudeDir, codexTranscriptDir, getDataDir, getProjectsDir, projectDir } from '@/lib/project/paths'
import { getSessionStatus, getSessionFirstMessage, getToolFromContainer } from '@/lib/session/status'
import { isTmuxSessionAlive } from '@/lib/session/cleanup'
import { readBlockedHosts } from '@/lib/session/blocked-hosts'
import { isPrewarmSession, readPrewarmSessions } from '@/lib/prewarm'
import { DaemonError } from '@/lib/daemon/errors'
import type { AgentTool } from '@/types'

export interface SessionListEntry {
  sessionId: string
  projectSlug: string
  tool: AgentTool
  status: 'running' | 'waiting' | 'prewarm'
  /** Container created time as 'YYYY-MM-DD HH:MM:SS' (UTC). */
  createdAt: string
  prompt?: string
  blockedHosts: string[]
}

export interface StaleSessionInfo {
  containerName: string
  projectSlug: string
  sessionId: string
  /** True when the container is still running but tmux is gone. */
  zombie: boolean
}

export interface FailedPrewarmInfo {
  slug: string
  fingerprint: string
  /** Unix epoch ms. */
  verifiedAt: number
}

export interface ActiveSessionsResult {
  sessions: SessionListEntry[]
  stale: StaleSessionInfo[]
  failedPrewarms: FailedPrewarmInfo[]
}

export interface DeletedSessionEntry {
  sessionId: string
  projectSlug: string
  tool: AgentTool
  /** 'YYYY-MM-DD HH:MM:SS' (UTC). */
  createdAt: string
}

async function ensureProjectExists(slug: string): Promise<void> {
  try {
    await fs.access(path.join(projectDir(slug), 'project.json'))
  } catch {
    throw new DaemonError('NOT_FOUND', `project ${slug} not found`)
  }
}

function formatCreated(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace('T', ' ').slice(0, 19)
}

/**
 * Enumerate managed containers for a project (or all projects), splitting
 * them into the active-session rows the renderer displays and the stale
 * set the caller is expected to tear down. Also collects failed-prewarm
 * entries so the renderer can surface them.
 */
export async function listActiveSessions(projectFilter?: string): Promise<ActiveSessionsResult> {
  if (projectFilter) await ensureProjectExists(projectFilter)

  const filters: Record<string, string[]> = {
    label: [`yaac.data-dir=${getDataDir()}`],
  }
  if (projectFilter) filters.label.push(`yaac.project=${projectFilter}`)

  let containers
  try {
    containers = await podman.listContainers({ all: true, filters })
  } catch (err) {
    throw new DaemonError('PODMAN_UNAVAILABLE', err instanceof Error ? err.message : String(err))
  }

  const running: typeof containers = []
  const stale: StaleSessionInfo[] = []
  for (const c of containers) {
    const name = c.Names?.[0]?.replace(/^\//, '') ?? c.Id
    const sessionId = c.Labels?.['yaac.session-id'] ?? ''
    const slug = c.Labels?.['yaac.project'] ?? ''

    if (c.State === 'running') {
      if (isTmuxSessionAlive(name)) {
        running.push(c)
      } else {
        stale.push({ containerName: name, projectSlug: slug, sessionId, zombie: true })
      }
      continue
    }
    stale.push({ containerName: name, projectSlug: slug, sessionId, zombie: false })
  }

  const sessions: SessionListEntry[] = await Promise.all(
    running.map(async (c): Promise<SessionListEntry> => {
      const sessionId = c.Labels?.['yaac.session-id'] ?? ''
      const slug = c.Labels?.['yaac.project'] ?? ''
      const tool = getToolFromContainer(c)
      if (!sessionId || !slug) {
        return {
          sessionId,
          projectSlug: slug,
          tool,
          status: 'running',
          createdAt: formatCreated(c.Created),
          blockedHosts: [],
        }
      }
      const [status, prompt, prewarm, blockedHosts] = await Promise.all([
        getSessionStatus(slug, sessionId, tool),
        getSessionFirstMessage(slug, sessionId, tool),
        isPrewarmSession(slug, sessionId),
        readBlockedHosts(slug, sessionId),
      ])
      return {
        sessionId,
        projectSlug: slug,
        tool,
        status: prewarm ? 'prewarm' : status,
        createdAt: formatCreated(c.Created),
        prompt,
        blockedHosts,
      }
    }),
  )

  const prewarmData = await readPrewarmSessions()
  const failedPrewarms: FailedPrewarmInfo[] = Object.entries(prewarmData)
    .filter(([, entry]) => entry.state === 'failed')
    .filter(([slug]) => !projectFilter || slug === projectFilter)
    .map(([slug, entry]) => ({
      slug,
      fingerprint: entry.fingerprint,
      verifiedAt: entry.verifiedAt,
    }))

  return { sessions, stale, failedPrewarms }
}

/**
 * Scan the Claude Code JSONL dirs and Codex transcript dirs for session
 * ids that no longer have a matching container. If podman is down, every
 * saved session is treated as deleted.
 */
export async function listDeletedSessions(projectFilter?: string): Promise<DeletedSessionEntry[]> {
  if (projectFilter) await ensureProjectExists(projectFilter)

  const slugs: string[] = []
  if (projectFilter) {
    slugs.push(projectFilter)
  } else {
    try {
      const entries = await fs.readdir(getProjectsDir())
      slugs.push(...entries)
    } catch {
      return []
    }
  }

  const activeSessionIds = new Set<string>()
  try {
    const containers = await podman.listContainers({
      all: true,
      filters: { label: [`yaac.data-dir=${getDataDir()}`] },
    })
    for (const c of containers) {
      const sid = c.Labels?.['yaac.session-id']
      if (sid) activeSessionIds.add(sid)
    }
  } catch {
    // podman not available — treat all as deleted
  }

  const deleted: DeletedSessionEntry[] = []

  for (const slug of slugs) {
    const claudeSessionsDir = path.join(claudeDir(slug), 'projects', '-workspace')
    try {
      const files = await fs.readdir(claudeSessionsDir)
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue
        const sessionId = file.replace('.jsonl', '')
        if (activeSessionIds.has(sessionId)) continue
        try {
          const stat = await fs.stat(path.join(claudeSessionsDir, file))
          deleted.push({
            sessionId,
            projectSlug: slug,
            tool: 'claude',
            createdAt: stat.birthtime.toISOString().replace('T', ' ').slice(0, 19),
          })
        } catch {
          continue
        }
      }
    } catch {
      // no claude sessions dir
    }

    const codexTranscripts = codexTranscriptDir(slug)
    try {
      const entries = await fs.readdir(codexTranscripts)
      for (const entry of entries) {
        if (!entry.endsWith('.jsonl')) continue
        const sessionId = entry.replace('.jsonl', '')
        if (activeSessionIds.has(sessionId)) continue
        const filePath = path.join(codexTranscripts, entry)
        try {
          const stat = await fs.lstat(filePath)
          deleted.push({
            sessionId,
            projectSlug: slug,
            tool: 'codex',
            createdAt: stat.birthtime.toISOString().replace('T', ' ').slice(0, 19),
          })
        } catch {
          continue
        }
      }
    } catch {
      // no codex transcript dir
    }
  }

  deleted.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return deleted
}
