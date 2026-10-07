import { useEffect, useSyncExternalStore } from 'react'
import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query'
import type { WorkspaceChanges } from '@yaac/shared/types'
import { api } from '#lib/api'
import { useUiStore } from '#lib/store'

/** How often a reader that is on screen and shows live changes polls. */
export const CHANGES_POLL_MS = 3000

/** How many mounted readers of each workspace want the diff body. */
const diffReaders = new Map<string, number>()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function addDiffReader(workspaceId: string, delta: number): void {
  const n = (diffReaders.get(workspaceId) ?? 0) + delta
  if (n > 0) diffReaders.set(workspaceId, n)
  else diffReaders.delete(workspaceId)
  for (const listener of listeners) listener()
}

/**
 * A workspace's changes since its diff base, shared by the status bar, the
 * explorer and every file pane through one query, so they poll the server
 * once between them. The base is the explorer's pick, else the server's
 * default (the branch the workspace forked from).
 *
 * The diff body can run to a megabyte, so it is fetched only while some
 * mounted reader asks for it (`diff`); every reader then shares that
 * answer. Each reader polls at its own `poll` interval (false: not at all),
 * and the query refetches at the shortest among them.
 */
export function useWorkspaceChanges(
  workspaceId: string,
  { diff = false, poll }: { diff?: boolean; poll: number | false },
): UseQueryResult<WorkspaceChanges> {
  useEffect(() => {
    if (!diff) return
    addDiffReader(workspaceId, 1)
    return () => addDiffReader(workspaceId, -1)
  }, [workspaceId, diff])
  const withDiff = useSyncExternalStore(subscribe, () => diffReaders.has(workspaceId))
  const base = useUiStore((s) => s.changesBase[workspaceId])
  return useQuery({
    queryKey: ['changes', workspaceId, base ?? null, withDiff],
    queryFn: () => api.workspace[':id'].changes.$get({
      param: { id: workspaceId },
      query: { ...(base ? { base } : {}), diff: withDiff ? '1' : '0' },
    }),
    refetchInterval: poll,
    staleTime: 1500,
    // A new base, or the body coming or going, keeps the old answer on
    // screen until the new one lands.
    placeholderData: keepPreviousData,
  })
}
