import { useEffect } from 'react'
import { skipToken, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { FULL_COMMIT_PATTERN } from '@yaac/shared/steps'
import type { WorkspaceChanges, WorkspaceComparison, WorkspaceFiles } from '@yaac/shared/types'
import { api } from '#lib/api'
import type { ChangesRange } from '#lib/files'

/** How often a reader that is on screen and shows live changes polls. */
export const CHANGES_POLL_MS = 3000

/** The listings a reader can want, costliest first. */
const LISTINGS = ['full', 'paths'] as const
type Listing = typeof LISTINGS[number]
type Part = 'diff' | Listing

/** The query cache key of a workspace's listing. */
export const filesKey = (workspaceId: string): unknown[] => ['files', workspaceId]

/** The changes query of a workspace, against its base branch or `base`. */
const changesKey = (workspaceId: string, base?: string): unknown[] => ['changes', workspaceId, ...base ? [base] : []]

/** Per changes query, how many mounted readers want each costly part. */
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
    const queryKey = changesKey(workspaceId, base)
    const counted = `${JSON.stringify(queryKey)}|${part}`
    readers.set(counted, (readers.get(counted) ?? 0) + 1)
    // Before the query's first fetch nothing is active yet, and that fetch
    // reads this part itself.
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
 * base is the server's, the branch the workspace is based on, unless a
 * Changes pane on a range ending at the working tree names `base`; that
 * pane polls a query of its own.
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
  { base, diff = false, listing, poll }: { base?: string; diff?: boolean; listing?: Listing; poll: number | false },
): UseQueryResult<WorkspaceChanges> {
  const queryKey = changesKey(workspaceId, base)
  const key = JSON.stringify(queryKey)
  useReader(workspaceId, base, diff ? 'diff' : undefined)
  useReader(workspaceId, base, listing)
  const queryClient = useQueryClient()
  return useQuery({
    queryKey,
    // Following `signal` lets a refetch that replaces a running one (a
    // reader mounting mid-poll) stop the old read on the server too.
    queryFn: async ({ signal }) => {
      // Readers mounted in the same commit register in their effects, all
      // of which run before this resumes, so one fetch serves them all.
      asked.set(key, 'pending')
      await Promise.resolve()
      const fetch = {
        diff: readers.has(`${key}|diff`),
        listing: LISTINGS.find((l) => readers.has(`${key}|${l}`)),
      }
      asked.set(key, fetch)
      const known = queryClient.getQueryData<WorkspaceFiles>(filesKey(workspaceId))?.version
      const { listing: fresh, ...rest } = await api.workspace[':id'].changes.$get({
        param: { id: workspaceId },
        query: {
          ...base ? { base } : {},
          diff: fetch.diff ? '1' : '0',
          ...(fetch.listing ? { listing: fetch.listing } : {}),
          ...(fetch.listing && known ? { known } : {}),
        },
      }, { init: { signal } })
      if (fresh) queryClient.setQueryData(filesKey(workspaceId), fresh)
      return rest
    },
    enabled: poll !== false,
    // The wait starts when an answer lands, so waiting as long as the last
    // read took keeps a slow checkout idle at least half the time. It stops
    // at 10 seconds: a slow read is usually the cold one, and the next is
    // fast.
    refetchInterval: poll === false ? false : (q) => Math.max(poll, Math.min(10_000, q.state.data?.readMs ?? 0)),
    staleTime: 1500,
  })
}

/** The listing the changes poll keeps current; undefined until it lands.
 *  Mount it beside a `useWorkspaceChanges` reader that asks for one. */
export function useWorkspaceFiles(workspaceId: string): WorkspaceFiles | undefined {
  return useQuery<WorkspaceFiles>({ queryKey: filesKey(workspaceId), queryFn: skipToken }).data
}

/**
 * The diff between two refs, for a Changes pane on a range that does not end
 * at the working tree (`GET /workspace/:id/compare`). Commits never change,
 * so a range between two full commit ids is read once; one naming a branch
 * or HEAD, which can move, is read again every 30 seconds while on screen.
 * Off when `range` is unset.
 */
export function useComparison(workspaceId: string, range: ChangesRange | undefined): UseQueryResult<WorkspaceComparison> {
  const fixed = range !== undefined && FULL_COMMIT_PATTERN.test(range.to)
    && (range.from === undefined || FULL_COMMIT_PATTERN.test(range.from))
  return useQuery({
    queryKey: ['compare', workspaceId, range?.from ?? null, range?.to ?? null],
    queryFn: range ? () => api.workspace[':id'].compare.$get({ param: { id: workspaceId }, query: range }) : skipToken,
    refetchInterval: fixed ? false : 30_000,
    staleTime: fixed ? Infinity : 0,
  })
}
