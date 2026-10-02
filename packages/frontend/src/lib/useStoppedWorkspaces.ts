import { useQuery, type QueryClient } from '@tanstack/react-query'
import { api } from '#lib/api'
import { useUiStore } from '#lib/store'
import type { StoppedWorkspaceEntry } from '@yaac/shared/types'

type Live = { workspaceId: string }[]

/**
 * The project's stopped workspaces for the sidebar (as `yaac workspace list
 * -s` lists them, with transcripts to resume): optimistic just-stopped
 * entries first, then the fetched list, minus any workspace that is still
 * stopping or restarting (those have live or provisioning rows).
 *
 * The list isn't in the snapshot, so the set of live ids is part of the
 * query key and any change refetches. The previous list for the project
 * stays shown while that fetch is in flight.
 */
export function useStoppedWorkspaces(
  projectSlug: string | null,
  workspaces: Live,
  provisioning: Live,
): StoppedWorkspaceEntry[] {
  const optimistic = useUiStore((s) => s.optimisticStopped)
  const removeOptimistic = useUiStore((s) => s.removeOptimisticStopped)
  const { data = [] } = useQuery({
    queryKey: ['stopped', projectSlug, workspaces.map((w) => w.workspaceId).sort().join(',')],
    queryFn: async () => {
      const list = await api.workspace['list-stopped'].$get({ query: { project: projectSlug ?? '', limit: '100' } })
      // An optimistic entry is no longer needed once the server lists it.
      for (const e of list) removeOptimistic(e.workspaceId)
      return list
    },
    enabled: projectSlug !== null,
    staleTime: 2000,
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === projectSlug ? prev : undefined),
  })

  const fetched = new Set(data.map((d) => d.workspaceId))
  const live = new Set([...workspaces, ...provisioning].map((w) => w.workspaceId))
  return [
    ...optimistic.filter((e) => e.projectSlug === projectSlug && !fetched.has(e.workspaceId)),
    ...data,
  ].filter((d) => !live.has(d.workspaceId))
}

/** Patch a project's cached stopped list so a change (e.g. marking a death
 *  seen, regrouping) shows before the server write returns. */
export function patchStopped(
  queryClient: QueryClient,
  projectSlug: string,
  patch: (e: StoppedWorkspaceEntry) => StoppedWorkspaceEntry,
): void {
  queryClient.setQueriesData<StoppedWorkspaceEntry[]>({ queryKey: ['stopped', projectSlug] }, (old) => old?.map(patch))
}
