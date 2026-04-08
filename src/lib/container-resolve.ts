import { podman } from '@/lib/podman'

/**
 * Resolves a container by prefix match on session ID or container name.
 * Returns the full container name, or null if not found/not running.
 */
export async function resolveContainer(idOrName: string): Promise<string | null> {
  let containers
  try {
    containers = await podman.listContainers({
      all: true,
      filters: { label: ['yaac.managed=true'] },
    })
  } catch {
    console.error('Failed to connect to Podman. Is the Podman machine running?')
    process.exitCode = 1
    return null
  }

  // Try exact match on session ID, container name, or container ID prefix
  const match = containers.find((c) => {
    const sessionId = c.Labels?.['yaac.session-id'] ?? ''
    const name = c.Names?.[0]?.replace(/^\//, '') ?? ''
    return sessionId === idOrName
      || name === idOrName
      || sessionId.startsWith(idOrName)
      || name.startsWith(idOrName)
      || c.Id.startsWith(idOrName)
  })

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
