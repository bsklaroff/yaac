import { useQuery } from '@tanstack/react-query'
import { api } from '#lib/api'
import { useSnapshot } from '#lib/useSnapshot'
import type { VolumeEntry } from '@yaac/shared/types'

/**
 * A project's workspace volumes (docs/workspace-volumes.md): named
 * data that one running workspace at a time mounts. Only a cluster has
 * them, so every volume control is hidden on a containerless server.
 */

/** Whether this server offers volumes. False until the snapshot says. */
export function useHasVolumes(): boolean {
  return useSnapshot()?.driver === 'k8s'
}

/**
 * The project's volumes, or undefined while loading or without volumes.
 * The list is not in the snapshot, but who holds a volume changes only as
 * the project's workspaces start and stop, so the project's live,
 * provisioning and stopped counts key the query: a change refetches it,
 * keeping the previous list meanwhile.
 */
export function useVolumes(projectId: string | null): VolumeEntry[] | undefined {
  const snapshot = useSnapshot()
  const enabled = useHasVolumes() && projectId !== null
  const ids = [...snapshot?.workspaces ?? [], ...snapshot?.provisioning ?? []]
    .filter((w) => w.projectId === projectId)
    .map((w) => w.workspaceId)
    .sort()
    .join(',')
  const stopped = snapshot?.projects.find((p) => p.id === projectId)?.stoppedCount ?? 0
  const { data } = useQuery({
    queryKey: [...volumesKey(projectId ?? ''), ids, stopped],
    queryFn: () => api.volume.list.$get({ query: { project: projectId ?? '' } }),
    enabled,
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === projectId ? prev : undefined),
  })
  return enabled ? data : undefined
}

/** Every cached list of a project's volumes, to invalidate after a write. */
export const volumesKey = (projectId: string): string[] => ['volumes', projectId]

