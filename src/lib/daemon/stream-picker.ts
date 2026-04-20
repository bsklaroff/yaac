import fs from 'node:fs/promises'
import { podman } from '@/lib/container/runtime'
import { getDataDir, getProjectsDir } from '@/lib/project/paths'
import { isTmuxSessionAlive } from '@/lib/session/cleanup'
import { isPrewarmSession } from '@/lib/prewarm'
import { getSessionFirstMessage } from '@/lib/session/status'
import { getWaitingSessions } from '@/lib/session/waiting'
import { createSession } from '@/commands/session-create'
import { DaemonError } from '@/lib/daemon/errors'
import type { AgentTool } from '@/types'

export type StreamOutcome = 'detached' | 'closed_blank' | 'closed_prompted' | 'none'

export interface PickNextInput {
  project?: string
  tool?: AgentTool
  visited: string[]
  lastVisited?: string
  /**
   * Project slug of the last-attached session. The daemon uses it to
   * look up the session transcript if the session disappeared between
   * this call and the previous one — which tells us whether the user
   * closed a blank session.
   */
  lastProjectSlug?: string
  lastTool?: AgentTool
  lastOutcome: StreamOutcome
}

export type PickNextResult =
  | {
      done: false
      sessionId: string
      containerName: string
      tmuxSession: 'yaac'
      projectSlug: string
      tool: AgentTool
      visited: string[]
      lastVisited: string
    }
  | {
      done: true
      reason: 'no_active' | 'closed_blank' | 'needs_project'
      candidates?: string[]
    }

async function getActiveProjects(): Promise<string[]> {
  const containers = await podman.listContainers({
    all: true,
    filters: { label: [`yaac.data-dir=${getDataDir()}`] },
  })
  const projects = new Set<string>()
  for (const c of containers) {
    const slug = c.Labels?.['yaac.project']
    if (!slug) continue
    if (c.State !== 'running') continue
    const name = c.Names?.[0]?.replace(/^\//, '') ?? c.Id
    if (!isTmuxSessionAlive(name)) continue
    if (await isPrewarmSession(slug, c.Labels?.['yaac.session-id'] ?? '')) continue
    projects.add(slug)
  }
  return [...projects].sort()
}

async function getAllProjects(): Promise<string[]> {
  try {
    const entries = await fs.readdir(getProjectsDir())
    return entries.sort()
  } catch {
    return []
  }
}

/**
 * State-machine for `POST /session/stream/next`. Given the client's
 * visited-set and last-outcome, picks the next waiting session for
 * `project` (or creates one), rotates the visited set when every
 * session has been seen, or signals the caller to disambiguate a
 * project / exit the stream.
 */
export async function pickNextStreamSession(input: PickNextInput): Promise<PickNextResult> {
  const allSessions = await getWaitingSessions(input.project)

  let visited = [...input.visited]
  let lastVisited = input.lastVisited
  let sessions = allSessions.filter((s) => !visited.includes(s.sessionId))

  if (sessions.length === 0 && allSessions.length > 0) {
    // Every waiting session has been visited — rotate so we can revisit,
    // but keep the most-recently-visited session excluded so we don't
    // bounce right back.
    visited = lastVisited ? [lastVisited] : []
    lastVisited = undefined
    sessions = allSessions.filter((s) => !visited.includes(s.sessionId))
  }

  if (sessions.length > 0) {
    const next = sessions[0]
    visited.push(next.sessionId)
    return {
      done: false,
      sessionId: next.sessionId,
      containerName: next.containerName,
      tmuxSession: 'yaac',
      projectSlug: next.projectSlug,
      tool: next.tool,
      visited,
      lastVisited: next.sessionId,
    }
  }

  const onlyVisitedBlank =
    allSessions.length === 1 &&
    input.visited.includes(allSessions[0].sessionId) &&
    !(await getSessionFirstMessage(
      allSessions[0].projectSlug,
      allSessions[0].sessionId,
      allSessions[0].tool,
    ))

  // If the last-attached session has disappeared from the waiting list
  // (container was killed/removed), treat it as closed_blank when its
  // transcript has no user message.
  let lastClosedBlank = false
  if (
    input.lastVisited &&
    input.lastProjectSlug &&
    input.lastTool &&
    !allSessions.some((s) => s.sessionId === input.lastVisited)
  ) {
    const firstMsg = await getSessionFirstMessage(
      input.lastProjectSlug, input.lastVisited, input.lastTool,
    )
    if (!firstMsg) lastClosedBlank = true
  }

  if (input.lastOutcome === 'closed_blank' || onlyVisitedBlank || lastClosedBlank) {
    return { done: true, reason: 'closed_blank' }
  }

  if (input.project) {
    const tool: AgentTool = input.tool ?? 'claude'
    const created = await createSession(input.project, { tool })
    if (!created?.sessionId || !created.containerName) {
      throw new DaemonError('INTERNAL', 'session creation returned no result')
    }
    visited.push(created.sessionId)
    return {
      done: false,
      sessionId: created.sessionId,
      containerName: created.containerName,
      tmuxSession: 'yaac',
      projectSlug: input.project,
      tool,
      visited,
      lastVisited: created.sessionId,
    }
  }

  const active = await getActiveProjects()
  if (active.length > 0) {
    return { done: true, reason: 'needs_project', candidates: active }
  }
  const all = await getAllProjects()
  if (all.length === 0) {
    return { done: true, reason: 'no_active' }
  }
  return { done: true, reason: 'needs_project', candidates: all }
}
