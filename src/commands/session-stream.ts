import { execSync } from 'node:child_process'
import { podman } from '@/lib/podman'
import { getDataDir } from '@/lib/paths'
import { getSessionClaudeStatus } from '@/lib/claude-status'
import { isTmuxSessionAlive, cleanupSession } from '@/lib/session-cleanup'
import { sessionCreate } from '@/commands/session-create'

export interface WaitingSession {
  containerName: string
  sessionId: string
  projectSlug: string
  created: number
}

export async function getWaitingSessions(
  projectSlug?: string,
  exclude?: Set<string>,
): Promise<WaitingSession[]> {
  const filters: Record<string, string[]> = {
    label: [`yaac.data-dir=${getDataDir()}`],
  }
  if (projectSlug) {
    filters.label.push(`yaac.project=${projectSlug}`)
  }

  const containers = await podman.listContainers({ all: true, filters })

  const running = containers.filter((c) => c.State === 'running')

  const results: WaitingSession[] = []
  for (const c of running) {
    const sessionId = c.Labels?.['yaac.session-id'] ?? ''
    const slug = c.Labels?.['yaac.project'] ?? ''
    const name = c.Names?.[0]?.replace(/^\//, '') ?? c.Id

    if (!sessionId || !slug) continue
    if (exclude?.has(sessionId)) continue

    const status = await getSessionClaudeStatus(slug, sessionId)
    if (status !== 'waiting') continue

    results.push({
      containerName: name,
      sessionId,
      projectSlug: slug,
      created: c.Created,
    })
  }

  results.sort((a, b) => a.created - b.created)
  return results
}

export async function sessionStream(project?: string): Promise<void> {
  const visited = new Set<string>()

  while (true) {
    let sessions: WaitingSession[]
    try {
      sessions = await getWaitingSessions(project, visited)
    } catch {
      console.error('Failed to connect to Podman. Is the Podman machine running?')
      process.exitCode = 1
      return
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

    execSync(`podman exec -it ${session.containerName} tmux attach-session -t yaac`, {
      stdio: 'inherit',
    })

    visited.add(session.sessionId)

    if (!isTmuxSessionAlive(session.containerName)) {
      console.log('Claude Code exited. Cleaning up session...')
      await cleanupSession({
        containerName: session.containerName,
        projectSlug: session.projectSlug,
        sessionId: session.sessionId,
      })
    }
  }
}
