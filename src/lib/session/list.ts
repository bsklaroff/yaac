import fs from 'node:fs/promises'
import path from 'node:path'
import { podman } from '@/lib/container/runtime'
import { claudeDir, codexTranscriptDir, getDataDir, getProjectsDir, projectDir } from '@/lib/project/paths'
import { getSessionStatus, getSessionFirstMessage, getToolFromContainer } from '@/lib/session/status'
import { isTmuxSessionAlive, cleanupSessionDetached } from '@/lib/session/cleanup'
import { readBlockedHosts } from '@/lib/session/blocked-hosts'
import { isPrewarmSession, readPrewarmSessions } from '@/lib/prewarm'
import { DaemonError } from '@/daemon/errors'
import type {
  ActiveSessionsResult,
  DeletedSessionEntry,
  FailedPrewarmInfo,
  SessionListEntry,
  StaleSessionInfo,
} from '@/shared/types'

export type {
  ActiveSessionsResult,
  DeletedSessionEntry,
  FailedPrewarmInfo,
  SessionListEntry,
  StaleSessionInfo,
}

/**
 * Default grace window that protects freshly-created session containers
 * from the stale-session reaper. session-create's retry loop recreates
 * the container between attempts and does not start tmux until the last
 * step, so without a grace period a concurrent `listActiveSessions` call
 * can classify the container as a zombie — firing cleanupSessionDetached,
 * which removes the session's allowedHosts from the proxy mid-creation.
 * Tests override this with YAAC_STARTING_GRACE_MS so they can provoke
 * cleanup on containers they just created.
 */
export const STARTING_GRACE_MS = 60_000

export function resolveStartingGraceMs(): number {
  const raw = process.env.YAAC_STARTING_GRACE_MS
  if (raw === undefined || raw === '') return STARTING_GRACE_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : STARTING_GRACE_MS
}

interface ClassifiableContainer {
  Id?: string
  Names?: string[]
  Labels?: Record<string, string>
  State?: string
  /** Unix epoch seconds, as returned by podman.listContainers. */
  Created?: number
}

/**
 * Split the container list into the ones the renderer should show as
 * active sessions, the ones the caller should tear down, and implicitly
 * (by omission) the ones that are still inside the startup grace window.
 */
export async function classifySessionContainers<T extends ClassifiableContainer>(
  containers: T[],
  nowMs: number,
  isTmuxAlive: (name: string) => Promise<boolean>,
  graceMs: number = STARTING_GRACE_MS,
): Promise<{ running: T[]; stale: StaleSessionInfo[] }> {
  const running: T[] = []
  const stale: StaleSessionInfo[] = []
  for (const c of containers) {
    const name = c.Names?.[0]?.replace(/^\//, '') ?? c.Id ?? ''
    const sessionId = c.Labels?.['yaac.session-id'] ?? ''
    const slug = c.Labels?.['yaac.project'] ?? ''

    if (c.State === 'running' && await isTmuxAlive(name)) {
      running.push(c)
      continue
    }

    const ageMs = typeof c.Created === 'number' ? nowMs - c.Created * 1000 : Infinity
    if (ageMs < graceMs) continue

    const zombie = c.State === 'running'
    stale.push({ containerName: name, projectSlug: slug, sessionId, zombie })
  }
  return { running, stale }
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

  const { running, stale } = await classifySessionContainers(
    containers, Date.now(), isTmuxSessionAlive, resolveStartingGraceMs(),
  )

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
 * Tear down stale session containers (stopped, or running with a dead
 * tmux session) across every project. Swallows individual failures so
 * one broken container can't block the rest; designed to be called from
 * the daemon background loop.
 */
export async function reconcileStaleSessions(): Promise<void> {
  let containers
  try {
    containers = await podman.listContainers({
      all: true,
      filters: { label: [`yaac.data-dir=${getDataDir()}`] },
    })
  } catch {
    return
  }
  const { stale } = await classifySessionContainers(
    containers, Date.now(), isTmuxSessionAlive, resolveStartingGraceMs(),
  )
  if (stale.length === 0) return
  await Promise.all(stale.map((s) =>
    cleanupSessionDetached({
      containerName: s.containerName,
      projectSlug: s.projectSlug,
      sessionId: s.sessionId,
    }).catch(() => { /* best-effort */ }),
  ))
}

/**
 * Scan the Claude Code JSONL dirs and Codex transcript dirs for session
 * ids that no longer have a matching container. If podman is down, every
 * saved session is treated as deleted.
 *
 * Entries are sorted newest-first and sliced to `limit` before prompts
 * are read — parsing each JSONL only for the rows the caller will render.
 * Pass `undefined` / `0` to disable the limit.
 */
export async function listDeletedSessions(
  projectFilter?: string,
  limit?: number,
): Promise<DeletedSessionEntry[]> {
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

  // Track ms-precision birthtime alongside each entry so the sort is
  // stable across files created in the same second (createdAt is
  // truncated to second precision for display).
  const collected: Array<{ entry: DeletedSessionEntry; birthtimeMs: number }> = []

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
          collected.push({
            entry: {
              sessionId,
              projectSlug: slug,
              tool: 'claude',
              createdAt: stat.birthtime.toISOString().replace('T', ' ').slice(0, 19),
            },
            birthtimeMs: stat.birthtimeMs,
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
          collected.push({
            entry: {
              sessionId,
              projectSlug: slug,
              tool: 'codex',
              createdAt: stat.birthtime.toISOString().replace('T', ' ').slice(0, 19),
            },
            birthtimeMs: stat.birthtimeMs,
          })
        } catch {
          continue
        }
      }
    } catch {
      // no codex transcript dir
    }
  }

  collected.sort((a, b) => b.birthtimeMs - a.birthtimeMs)
  const slice = limit && limit > 0 ? collected.slice(0, limit) : collected
  const capped = slice.map((r) => r.entry)
  await Promise.all(capped.map(async (entry) => {
    entry.prompt = await getSessionFirstMessage(entry.projectSlug, entry.sessionId, entry.tool)
  }))
  return capped
}
