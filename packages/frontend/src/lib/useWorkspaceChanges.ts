import { useEffect } from 'react'
import { keepPreviousData, skipToken, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import type { WorkspaceChanges, WorkspaceFiles } from '@yaac/shared/types'
import { api } from '#lib/api'
import { useUiStore } from '#lib/store'

/** How often a reader that is on screen and shows live changes polls. */
export const CHANGES_POLL_MS = 3000

/** The listings a reader can want, costliest first. */
const LISTINGS = ['full', 'paths'] as const
type Listing = typeof LISTINGS[number]
type Part = 'diff' | Listing

/** The query cache key of a workspace's listing. */
export const filesKey = (workspaceId: string): unknown[] => ['files', workspaceId]

/** The changes query of a workspace against a picked base, or the default. */
const changesKey = (workspaceId: string, base: string | undefined): unknown[] => ['changes', workspaceId, base ?? null]

/** Per workspace, how many mounted readers want each costly part. */
const readers = new Map<string, number>()

/** Per changes query, what its latest fetch asked for; `pending` until it
 *  has read the readers, which then include every one registered so far. */
const asked = new Map<string, { diff: boolean; listing?: Listing } | 'pending'>()

function covers(fetch: { diff: boolean; listing?: Listing } | 'pending' | undefined, part: Part): boolean {
  if (!fetch) return false
  if (fetch === 'pending') return true
  if (part === 'diff') return fetch.diff
  return fetch.listing === 'full' || fetch.listing === part
}

/**
 * Count this component as a reader of `part` while it is mounted. A part
 * the latest fetch did not ask for is fetched now, not at the next poll.
 */
function useReader(workspaceId: string, base: string | undefined, part: Part | undefined): void {
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!part) return
    const counted = `${workspaceId}|${part}`
    readers.set(counted, (readers.get(counted) ?? 0) + 1)
    // Before the query's first fetch nothing is active yet, and that fetch
    // reads this part itself.
    const queryKey = changesKey(workspaceId, base)
    if (!covers(asked.get(JSON.stringify(queryKey)), part)) void queryClient.refetchQueries({ queryKey, type: 'active' })
    return () => {
      const n = (readers.get(counted) ?? 0) - 1
      if (n > 0) readers.set(counted, n)
      else readers.delete(counted)
    }
  }, [queryClient, workspaceId, base, part])
}

/**
 * A workspace's changes since its diff base, how far HEAD is from the base
 * branch, and its listing: everything the webapp polls about a checkout,
 * shared by the status bar, the explorer, the Changes pane and every file
 * pane through one query, so they poll the server once between them. The
 * base is the Changes pane's pick, else the server's default (the branch the workspace
 * forked from).
 *
 * The diff body can run to a megabyte and a full listing walks the working
 * tree, so a fetch asks for each only while some mounted reader wants it
 * (`diff`, `listing`). Which ones is read when the fetch runs, not put in
 * the key, so readers coming and going never split the query. Each reader
 * polls at its own `poll` interval; a reader with `poll: false` (a hidden
 * pane) never fetches and only reads what the others fetched.
 *
 * The listing lands in its own cache entry (`useWorkspaceFiles`). Each poll
 * sends the version held there, and the server leaves out a listing that
 * has not changed.
 */
export function useWorkspaceChanges(
  workspaceId: string,
  { diff = false, listing, poll }: { diff?: boolean; listing?: Listing; poll: number | false },
): UseQueryResult<WorkspaceChanges> {
  const base = useUiStore((s) => s.changesBase[workspaceId])
  const queryKey = changesKey(workspaceId, base)
  useReader(workspaceId, base, diff ? 'diff' : undefined)
  useReader(workspaceId, base, listing)
  const queryClient = useQueryClient()
  return useQuery({
    queryKey,
    queryFn: async () => {
      // Readers mounted in the same commit register in their effects, all
      // of which run before this resumes, so one fetch serves them all.
      asked.set(JSON.stringify(queryKey), 'pending')
      await Promise.resolve()
      const fetch = {
        diff: readers.has(`${workspaceId}|diff`),
        listing: LISTINGS.find((l) => readers.has(`${workspaceId}|${l}`)),
      }
      asked.set(JSON.stringify(queryKey), fetch)
      const known = queryClient.getQueryData<WorkspaceFiles>(filesKey(workspaceId))?.version
      const { listing: fresh, ...rest } = await api.workspace[':id'].changes.$get({
        param: { id: workspaceId },
        query: {
          ...(base ? { base } : {}),
          diff: fetch.diff ? '1' : '0',
          ...(fetch.listing ? { listing: fetch.listing } : {}),
          ...(fetch.listing && known ? { known } : {}),
        },
      })
      if (fresh) queryClient.setQueryData(filesKey(workspaceId), fresh)
      return rest
    },
    enabled: poll !== false,
    refetchInterval: poll,
    staleTime: 1500,
    // A new base keeps the old answer on screen until its own lands.
    placeholderData: keepPreviousData,
  })
}

/** The listing the changes poll keeps current; undefined until it lands.
 *  Mount it beside a `useWorkspaceChanges` reader that asks for one. */
export function useWorkspaceFiles(workspaceId: string): WorkspaceFiles | undefined {
  return useQuery<WorkspaceFiles>({ queryKey: filesKey(workspaceId), queryFn: skipToken }).data
}
