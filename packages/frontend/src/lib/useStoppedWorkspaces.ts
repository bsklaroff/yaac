import { useEffect } from 'react'
import { useQuery, type QueryClient } from '@tanstack/react-query'
import { getStoppedWorkspaces } from '#lib/stoppedApi'
import { useUiStore } from '#lib/store'
import type { StoppedWorkspaceEntry } from '@yaac/shared/types'

type Live = { workspaceId: string }[]

/**
 * The project's stopped workspaces as the sidebar draws them: optimistic
 * just-stopped entries ahead of the fetched list, minus anything live again —
 * a workspace mid-termination is still in the snapshot (its row renders the
 * stopping placeholder), and one mid-restart has a provisioning row.
 *
 * The list isn't snapshot-pushed, so the live set is part of the query key:
 * a change to it (a workspace stopped, a restart landed) is a fresh fetch. The
 * last list for the same project stays on screen until that fetch lands, so
 * the ghost rows and the entry point never blink out while it is in flight.
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
    queryFn: () => getStoppedWorkspaces(projectSlug ?? '', 100),
    enabled: projectSlug !== null,
    staleTime: 2000,
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === projectSlug ? prev : undefined),
  })

  // Once the listing catches up to an optimistic entry, the fetched copy takes
  // over (same id, no flicker).
  useEffect(() => {
    const fetched = new Set(data.map((d) => d.workspaceId))
    for (const e of optimistic) if (fetched.has(e.workspaceId)) removeOptimistic(e.workspaceId)
  }, [data, optimistic, removeOptimistic])

  const fetched = new Set(data.map((d) => d.workspaceId))
  const live = new Set([...workspaces, ...provisioning].map((w) => w.workspaceId))
  return [
    ...optimistic.filter((e) => e.projectSlug === projectSlug && !fetched.has(e.workspaceId)),
    ...data,
  ].filter((d) => !live.has(d.workspaceId))
}

/** Patch a project's cached stopped listing in place — an acknowledgement or
 *  regroup shows at once, and the server write makes it durable. */
export function patchStopped(
  queryClient: QueryClient,
  projectSlug: string,
  patch: (e: StoppedWorkspaceEntry) => StoppedWorkspaceEntry,
): void {
  queryClient.setQueriesData<StoppedWorkspaceEntry[]>({ queryKey: ['stopped', projectSlug] }, (old) => old?.map(patch))
}
