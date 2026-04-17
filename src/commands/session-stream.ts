import { execSync } from 'node:child_process'
import fs from 'node:fs/promises'
import readline from 'node:readline/promises'
import { podman } from '@/lib/container/runtime'
import { getDataDir, getProjectsDir } from '@/lib/project/paths'
import { getSessionFirstMessage, getSessionStatus, getToolFromContainer } from '@/lib/session/status'
import { isTmuxSessionAlive, cleanupSessionDetached } from '@/lib/session/cleanup'
import { finalizeAttachedSession, type AttachOutcome } from '@/lib/session/finalize-attached-session'
import { createSession } from '@/commands/session-create'
import { isPrewarmSession } from '@/lib/prewarm'
import type { AgentTool } from '@/types'

export interface WaitingSession {
  containerName: string
  sessionId: string
  projectSlug: string
  created: number
  tool: AgentTool
}

interface StreamState {
  visited: Set<string>
  cleaning: Set<string>
  lastVisited?: string
  lastAttachOutcome: AttachOutcome | 'none'
}

type StreamAction =
  | { type: 'attach'; session: WaitingSession }
  | { type: 'create_session'; project: string }
  | { type: 'exit' }

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

    const tool = getToolFromContainer(c)
    const status = await getSessionStatus(slug, sessionId, tool)
    if (status !== 'waiting') continue

    results.push({
      containerName: name,
      sessionId,
      projectSlug: slug,
      created: c.Created,
      tool,
    })
  }

  // Clean up stale sessions in background
  if (stale.length > 0) {
    console.log(`Cleaning up ${stale.length} stale session(s): ${stale.map((s) => s.sessionId.slice(0, 8)).join(', ')}`)
    await Promise.all(stale.map(({ name, slug, sessionId }) =>
      cleanupSessionDetached({ containerName: name, projectSlug: slug, sessionId }),
    ))
  }

  results.sort((a, b) => a.created - b.created)
  return results
}

async function getActiveProjects(): Promise<string[]> {
  const filters: Record<string, string[]> = {
    label: [`yaac.data-dir=${getDataDir()}`],
  }
  const containers = await podman.listContainers({ all: true, filters })
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
  const projectsDir = getProjectsDir()
  try {
    const entries = await fs.readdir(projectsDir)
    return entries.sort()
  } catch {
    return []
  }
}

export async function promptForProject(projects: string[], message: string): Promise<string | undefined> {
  if (projects.length === 0) return
  console.log(`\n${message}`)
  for (let i = 0; i < projects.length; i++) {
    console.log(`  ${i + 1}) ${projects[i]}`)
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question('\nSelect a project (number): ')
    const index = parseInt(answer.trim(), 10) - 1
    if (index >= 0 && index < projects.length) return projects[index]
    console.log('Invalid selection.')
    return
  } finally {
    rl.close()
  }
}

async function resolveProject(): Promise<string | undefined> {
  // Check which projects have active (running/waiting) containers
  let activeProjects: string[]
  try {
    activeProjects = await getActiveProjects()
  } catch {
    activeProjects = []
  }

  if (activeProjects.length === 1) {
    console.log(`Starting session stream for "${activeProjects[0]}" (only project with active sessions)...`)
    return activeProjects[0]
  }

  if (activeProjects.length > 1) {
    const selected = await promptForProject(
      activeProjects,
      'Multiple projects have active sessions:',
    )
    return selected
  }

  // No active containers — fall back to all configured projects
  const allProjects = await getAllProjects()
  if (allProjects.length === 0) {
    console.log('No projects found. Add one with: yaac project add <remote-url>')
    return
  }

  if (allProjects.length === 1) {
    console.log(`Starting session stream for "${allProjects[0]}" (only configured project)...`)
    return allProjects[0]
  }

  const selected = await promptForProject(
    allProjects,
    'No active sessions. Select a project:',
  )
  return selected
}

async function loadWaitingSessions(
  project: string | undefined,
  cleaning: Set<string>,
): Promise<WaitingSession[] | undefined> {
  try {
    return await getWaitingSessions(project, cleaning)
  } catch {
    // The podman socket connection may have gone stale while we were
    // blocked inside execSync (tmux attach). Retry once before giving up.
    try {
      return await getWaitingSessions(project, cleaning)
    } catch {
      console.error('Failed to connect to Podman. Is the Podman machine running?')
      process.exitCode = 1
      return
    }
  }
}

async function chooseNextAction(
  allSessions: WaitingSession[],
  state: StreamState,
  project: string | undefined,
): Promise<StreamAction> {
  let sessions = allSessions.filter((s) => !state.visited.has(s.sessionId))

  if (sessions.length === 0 && allSessions.length > 0) {
    // All waiting sessions have been visited — clear the set so we can
    // revisit them, but keep the most-recently-visited session excluded
    // so we never bounce back to the one we just left.
    state.visited.clear()
    if (state.lastVisited) state.visited.add(state.lastVisited)
    state.lastVisited = undefined
    sessions = allSessions.filter((s) => !state.visited.has(s.sessionId))
  }

  if (sessions.length > 0) {
    return { type: 'attach', session: sessions[0] }
  }

  const shouldExitForOnlyVisitedBlankSession = (
    allSessions.length === 1 &&
    state.visited.has(allSessions[0].sessionId) &&
    !await getSessionFirstMessage(
      allSessions[0].projectSlug,
      allSessions[0].sessionId,
      allSessions[0].tool,
    )
  )

  if (state.lastAttachOutcome === 'closed_blank' || shouldExitForOnlyVisitedBlankSession) {
    console.log('Closed blank session and found no waiting sessions. Exiting session stream.')
    return { type: 'exit' }
  }

  if (project) {
    return { type: 'create_session', project }
  }

  const selected = await resolveProject()
  if (!selected) {
    console.log('No project selected. Exiting session stream.')
    return { type: 'exit' }
  }

  return { type: 'create_session', project: selected }
}

async function attachAndFinalize(session: WaitingSession, cleaning: Set<string>): Promise<AttachOutcome> {
  const shortId = session.sessionId.slice(0, 8)
  console.log(`Attaching to session ${shortId} (project: ${session.projectSlug})...`)

  try {
    execSync(`podman exec -it ${session.containerName} tmux attach-session -t yaac`, {
      stdio: 'inherit',
    })
  } catch {
    // Container or tmux session was killed (e.g. ctrl-b k) — fall through to cleanup
  }

  return finalizeAttachedSession({
    containerName: session.containerName,
    projectSlug: session.projectSlug,
    sessionId: session.sessionId,
    tool: session.tool,
    cleaning,
  })
}

export async function sessionStream(project?: string, tool?: AgentTool): Promise<void> {
  const state: StreamState = {
    visited: new Set<string>(),
    cleaning: new Set<string>(),
    lastAttachOutcome: 'none',
  }
  let currentProject = project

  while (true) {
    const allSessions = await loadWaitingSessions(currentProject, state.cleaning)
    if (!allSessions) return

    const action = await chooseNextAction(allSessions, state, currentProject)

    switch (action.type) {
      case 'attach':
        state.visited.add(action.session.sessionId)
        state.lastVisited = action.session.sessionId
        state.lastAttachOutcome = await attachAndFinalize(action.session, state.cleaning)
        break
      case 'exit':
        return
      case 'create_session':
        console.log(`No waiting sessions. Creating a new session for "${action.project}"...`)
        currentProject = action.project
        const createdSession = await createSession(action.project, { tool })
        if (createdSession?.sessionId) {
          state.visited.add(createdSession.sessionId)
          state.lastVisited = createdSession.sessionId
        }
        state.lastAttachOutcome = createdSession?.attachOutcome ?? 'none'
        break
    }
  }
}
