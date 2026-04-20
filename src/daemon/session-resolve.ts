import { podman } from '@/lib/container/runtime'
import { getDataDir } from '@/lib/project/paths'
import { DaemonError } from '@/daemon/errors'

export interface ResolvedSession {
  containerName: string
  sessionId: string
  projectSlug: string
  state: string
}

/**
 * Resolve a session container by session ID (full or prefix), container
 * name, or container ID prefix. Mirrors the CLI-side
 * `resolveContainerAnyState` logic in `src/lib/container/resolve.ts` but
 * throws `DaemonError` codes instead of writing to stderr.
 */
export async function resolveSessionContainer(
  idOrName: string,
  opts: { requireRunning?: boolean } = {},
): Promise<ResolvedSession> {
  let containers
  try {
    containers = await podman.listContainers({
      all: true,
      filters: { label: [`yaac.data-dir=${getDataDir()}`] },
    })
  } catch (err) {
    throw new DaemonError('PODMAN_UNAVAILABLE', err instanceof Error ? err.message : String(err))
  }

  const match = containers.find((c) => {
    const sessionId = c.Labels?.['yaac.session-id'] ?? ''
    const name = c.Names?.[0]?.replace(/^\//, '') ?? ''
    return sessionId === idOrName
      || name === idOrName
      || sessionId.startsWith(idOrName)
      || c.Id.startsWith(idOrName)
  })

  if (!match) throw new DaemonError('NOT_FOUND', `session ${idOrName} not found`)

  const state = match.State ?? 'unknown'
  const containerName = match.Names?.[0]?.replace(/^\//, '') ?? match.Id
  if (opts.requireRunning && state !== 'running') {
    throw new DaemonError('CONFLICT', `container "${containerName}" is not running (state: ${state})`)
  }

  return {
    containerName,
    sessionId: match.Labels?.['yaac.session-id'] ?? '',
    projectSlug: match.Labels?.['yaac.project'] ?? '',
    state,
  }
}
