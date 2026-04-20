import { podman } from '@/lib/container/runtime'
import { getDataDir } from '@/lib/project/paths'
import { cleanupSessionDetached } from '@/lib/session/cleanup'
import { DaemonError } from '@/daemon/errors'

export interface DeletedSessionInfo {
  sessionId: string
  containerName: string
  projectSlug: string
}

/**
 * Resolve a session by prefix match on id or container name and schedule
 * a detached cleanup (stop container + remove + prune worktree). Throws
 * `NOT_FOUND` if nothing matches, `PODMAN_UNAVAILABLE` if podman can't
 * be reached.
 */
export async function deleteSession(idOrName: string): Promise<DeletedSessionInfo> {
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

  if (!match) {
    throw new DaemonError(
      'NOT_FOUND',
      `No session found matching "${idOrName}". Run "yaac session list" to see active sessions.`,
    )
  }

  const info: DeletedSessionInfo = {
    containerName: match.Names?.[0]?.replace(/^\//, '') ?? match.Id,
    sessionId: match.Labels?.['yaac.session-id'] ?? '',
    projectSlug: match.Labels?.['yaac.project'] ?? '',
  }

  await cleanupSessionDetached(info)
  return info
}
