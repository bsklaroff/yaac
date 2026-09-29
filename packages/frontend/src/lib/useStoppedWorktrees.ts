import { useEffect } from 'react'
import { useQuery, type QueryClient } from '@tanstack/react-query'
import { getStoppedWorktrees } from '#lib/stoppedApi'
import { useUiStore } from '#lib/store'
import type { StoppedWorktreeEntry } from '@yaac/shared/types'

type Live = { worktreeId: string }[]

/**
 * The project's stopped worktrees as the sidebar draws them: optimistic
 * just-stopped entries ahead of the fetched list, minus anything live again —
 * a worktree mid-termination is still in the snapshot (its row renders the
 * stopping placeholder), and one mid-restart has a provisioning row.
 *
 * The list isn't snapshot-pushed, so the live set is part of the query key:
 * a change to it (a worktree stopped, a restart landed) is a fresh fetch. The
 * last list for the same project stays on screen until that fetch lands, so
 * the ghost rows and the entry point never blink out while it is in flight.
 */
export function useStoppedWorktrees(
  projectSlug: string | null,
  worktrees: Live,
  provisioning: Live,
): StoppedWorktreeEntry[] {
  const optimistic = useUiStore((s) => s.optimisticStopped)
  const removeOptimistic = useUiStore((s) => s.removeOptimisticStopped)
  const { data = [] } = useQuery({
    queryKey: ['stopped', projectSlug, worktrees.map((w) => w.worktreeId).sort().join(',')],
    queryFn: () => getStoppedWorktrees(projectSlug ?? '', 100),
    enabled: projectSlug !== null,
    staleTime: 2000,
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === projectSlug ? prev : undefined),
  })

  // Once the listing catches up to an optimistic entry, the fetched copy takes
  // over (same id, no flicker).
  useEffect(() => {
    const fetched = new Set(data.map((d) => d.worktreeId))
    for (const e of optimistic) if (fetched.has(e.worktreeId)) removeOptimistic(e.worktreeId)
  }, [data, optimistic, removeOptimistic])

  const fetched = new Set(data.map((d) => d.worktreeId))
  const live = new Set([...worktrees, ...provisioning].map((w) => w.worktreeId))
  return [
    ...optimistic.filter((e) => e.projectSlug === projectSlug && !fetched.has(e.worktreeId)),
    ...data,
  ].filter((d) => !live.has(d.worktreeId))
}

/** Patch a project's cached stopped listing in place — an acknowledgement or
 *  regroup shows at once, and the server write makes it durable. */
export function patchStopped(
  queryClient: QueryClient,
  projectSlug: string,
  patch: (e: StoppedWorktreeEntry) => StoppedWorktreeEntry,
): void {
  queryClient.setQueriesData<StoppedWorktreeEntry[]>({ queryKey: ['stopped', projectSlug] }, (old) => old?.map(patch))
}
