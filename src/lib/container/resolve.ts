import { podman } from '@/lib/container/runtime'
import { getDataDir } from '@/lib/project/paths'

export interface ResolvedContainer {
  name: string
  sessionId: string
  projectSlug: string
  state: string
}

function listManagedContainers() {
  return podman.listContainers({
    all: true,
    filters: { label: [`yaac.data-dir=${getDataDir()}`] },
  })
}

function findMatch(containers: Awaited<ReturnType<typeof listManagedContainers>>, idOrName: string) {
  return containers.find((c) => {
    const sessionId = c.Labels?.['yaac.session-id'] ?? ''
    const name = c.Names?.[0]?.replace(/^\//, '') ?? ''
    return sessionId === idOrName
      || name === idOrName
      || sessionId.startsWith(idOrName)
      || c.Id.startsWith(idOrName)
  })
}

/**
 * Resolves a container by prefix match on session ID or container name.
 * Returns the full container name, or null if not found/not running.
 */
export async function resolveContainer(idOrName: string): Promise<string | null> {
  let containers
  try {
    containers = await listManagedContainers()
  } catch {
    console.error('Failed to connect to Podman. Is the Podman machine running?')
    process.exitCode = 1
    return null
  }

  const match = findMatch(containers, idOrName)

  if (!match) {
    console.error(`No session found matching "${idOrName}". Run "yaac session list" to see active sessions.`)
    process.exitCode = 1
    return null
  }

  if (match.State !== 'running') {
    const name = match.Names?.[0]?.replace(/^\//, '') ?? match.Id.slice(0, 12)
    console.error(`Container "${name}" is not running (state: ${match.State}).`)
    process.exitCode = 1
    return null
  }

  return match.Names?.[0]?.replace(/^\//, '') ?? match.Id
}

/**
 * Resolves a container by prefix match, accepting any state (running, stopped, exited).
 */
export async function resolveContainerAnyState(idOrName: string): Promise<ResolvedContainer | null> {
  let containers
  try {
    containers = await listManagedContainers()
  } catch {
    console.error('Failed to connect to Podman. Is the Podman machine running?')
    process.exitCode = 1
    return null
  }

  const match = findMatch(containers, idOrName)

  if (!match) {
    console.error(`No session found matching "${idOrName}". Run "yaac session list" to see active sessions.`)
    process.exitCode = 1
    return null
  }

  return {
    name: match.Names?.[0]?.replace(/^\//, '') ?? match.Id,
    sessionId: match.Labels?.['yaac.session-id'] ?? '',
    projectSlug: match.Labels?.['yaac.project'] ?? '',
    state: match.State ?? 'unknown',
  }
}
