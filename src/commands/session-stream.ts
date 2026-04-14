import { execSync } from 'node:child_process'
import { podman } from '@/lib/container/runtime'
import { getDataDir } from '@/lib/project/paths'
import { getSessionClaudeStatus } from '@/lib/session/claude-status'
import { isTmuxSessionAlive, cleanupSessionDetached } from '@/lib/session/cleanup'
import { sessionCreate } from '@/commands/session-create'
import { isPrewarmSession } from '@/lib/prewarm'

export interface WaitingSession {
  containerName: string
  sessionId: string
  projectSlug: string
  created: number
}

export async function getWaitingSessions(
  projectSlug?: string,
  alreadyCleaning?: Set<string>,
): Promise<WaitingSession[]> {
  const filters: Record<string, string[]> = {
    label: [`yaac.data-dir=${getDataDir()}`],
  }
  if (projectSlug) {
    filters.label.push(`yaac.project=${projectSlug}`)
  }

  const containers = await podman.listContainers({ all: true, filters })

  const results: WaitingSession[] = []
  const stale: Array<{ name: string; slug: string; sessionId: string }> = []

  for (const c of containers) {
    const sessionId = c.Labels?.['yaac.session-id'] ?? ''
    const slug = c.Labels?.['yaac.project'] ?? ''
    const name = c.Names?.[0]?.replace(/^\//, '') ?? c.Id

    if (!sessionId || !slug) continue

    // Skip sessions that already have cleanup in progress
    if (alreadyCleaning?.has(sessionId)) continue

    // Non-running containers are stale
    if (c.State !== 'running') {
      stale.push({ name, slug, sessionId })
      continue
    }

    // Running containers with a dead tmux session are zombies
    if (!isTmuxSessionAlive(name)) {
      stale.push({ name, slug, sessionId })
      continue
    }

    // Skip prewarm sessions — they are claimed via sessionCreate, not cycled through
    if (await isPrewarmSession(slug, sessionId)) continue

    const status = await getSessionClaudeStatus(slug, sessionId)
    if (status !== 'waiting') continue

    results.push({
      containerName: name,
      sessionId,
      projectSlug: slug,
      created: c.Created,
    })
  }

  // Clean up stale sessions in background
  if (stale.length > 0) {
    console.log(`Cleaning up ${stale.length} stale session(s): ${stale.map((s) => s.sessionId.slice(0, 8)).join(', ')}`)
    for (const { name, slug, sessionId } of stale) {
      cleanupSessionDetached({ containerName: name, projectSlug: slug, sessionId })
    }
  }

  results.sort((a, b) => a.created - b.created)
  return results
}

export async function sessionStream(project?: string): Promise<void> {
  const visited = new Set<string>()
  const cleaning = new Set<string>()
  let lastVisited: string | undefined

  while (true) {
    let allSessions: WaitingSession[]
    try {
      allSessions = await getWaitingSessions(project, cleaning)
    } catch {
      // The podman socket connection may have gone stale while we were
      // blocked inside execSync (tmux attach). Retry once before giving up.
      try {
        allSessions = await getWaitingSessions(project, cleaning)
      } catch {
        console.error('Failed to connect to Podman. Is the Podman machine running?')
        process.exitCode = 1
        return
      }
    }

    let sessions = allSessions.filter((s) => !visited.has(s.sessionId))

    if (sessions.length === 0 && allSessions.length > 0) {
      // All waiting sessions have been visited — clear the set so we can
      // revisit them, but keep the most-recently-visited session excluded
      // so we never bounce back to the one we just left.
      visited.clear()
      if (lastVisited) visited.add(lastVisited)
      lastVisited = undefined
      sessions = allSessions.filter((s) => !visited.has(s.sessionId))
    }

    if (sessions.length === 0) {
      if (project) {
        console.log(`No waiting sessions. Creating a new session for "${project}"...`)
        await sessionCreate(project, {})
        continue
      }
      console.log('No waiting sessions. Exiting.')
      return
    }

    const session = sessions[0]
    const shortId = session.sessionId.slice(0, 8)
    console.log(`Attaching to session ${shortId} (project: ${session.projectSlug})...`)

    try {
      execSync(`podman exec -it ${session.containerName} tmux attach-session -t yaac`, {
        stdio: 'inherit',
      })
    } catch {
      // Container or tmux session was killed (e.g. ctrl-b k) — fall through to cleanup
    }

    visited.add(session.sessionId)
    lastVisited = session.sessionId

    if (!isTmuxSessionAlive(session.containerName)) {
      console.log('Claude Code exited. Cleaning up session...')
      cleaning.add(session.sessionId)
      cleanupSessionDetached({
        containerName: session.containerName,
        projectSlug: session.projectSlug,
        sessionId: session.sessionId,
      })
    }
  }
}
