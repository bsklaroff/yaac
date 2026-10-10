import { useEffect, useRef } from 'react'
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query'
import { api } from '#lib/api'
import { useUiStore } from '#lib/store'
import { useProvisionWorkspace } from '#lib/useProvisionWorkspace'
import { restartWorkspace } from '#lib/createWorkspace'
import type {
  HeldWorkspaceEntry,
  ProvisioningWorkspaceEntry,
  StoppedWorkspaceEntry,
  StoppedWorkspacePage,
  WorkspaceGroupSummary,
} from '@yaac/shared/types'

/** Rows per page of the stopped listing. */
export const STOPPED_PAGE_SIZE = 50

/** What a stopped list is narrowed to (see `GET /workspace/list-stopped`). */
export interface StoppedFilter {
  q?: string
  /** Only this group's members (a group's ghost rows). */
  group?: string
  /** Leave out these groups' members (the Stopped section, while those
   *  groups show their own ghosts). */
  excludeGroups?: string[]
  /** Leave out these workspaces, which have rows elsewhere (held, or
   *  restarting), so the server's total counts only what is listed. */
  exclude?: string[]
}

export interface StoppedList {
  /** Optimistic just-stopped entries first, then the loaded pages, minus
   *  any id in `hidden`. */
  entries: StoppedWorkspaceEntry[]
  /** The server's total for the filter; undefined before the first page. */
  total: number | undefined
  /** False while the rows are a previous filter's placeholder. */
  hasNextPage: boolean
  /** Any fetch in flight, including a refetch of the loaded pages. */
  isFetching: boolean
  isFetchingNextPage: boolean
  /** The rows are not yet this filter's: its first page is still loading. */
  settling: boolean
  isError: boolean
  fetchNextPage: () => void
}

/**
 * One of the project's stopped lists, a page at a time, newest stop first.
 *
 * The list isn't in the snapshot, so `version` (built from the snapshot's
 * stopped counts) is what says it changed: a new value refetches every
 * loaded page. `hidden` names workspaces drawn elsewhere (live, provisioning
 * or held rows). Optimistic entries are shown until a fetched page lists
 * them, and only without a search, since the server does the matching.
 *
 * Every request carries the query's abort signal, so a superseded search,
 * a cancelled refetch or an unmounted list drops its request rather than
 * leaving it to pile up on the server.
 */
export function useStoppedWorkspaces(
  projectId: string | null,
  filter: StoppedFilter,
  opts: { enabled: boolean; version: string; hidden: ReadonlySet<string> },
): StoppedList {
  const optimistic = useUiStore((s) => s.optimisticStopped)
  const removeOptimistic = useUiStore((s) => s.removeOptimisticStopped)
  const queryClient = useQueryClient()
  const q = filter.q?.trim() ?? ''
  const excludeGroups = [...(filter.excludeGroups ?? [])].sort().join(',')
  const exclude = [...(filter.exclude ?? [])].sort().join(',')
  const query = useInfiniteQuery({
    queryKey: ['stopped', projectId, q, filter.group ?? '', excludeGroups, exclude],
    queryFn: async ({ pageParam, signal }) => {
      const page = await api.workspace['list-stopped'].$get({
        query: {
          project: projectId ?? '',
          limit: String(STOPPED_PAGE_SIZE),
          ...(pageParam ? { cursor: pageParam } : {}),
          ...(q ? { q } : {}),
          ...(filter.group !== undefined ? { group: filter.group } : {}),
          ...(excludeGroups ? { excludeGroups } : {}),
          ...(exclude ? { exclude } : {}),
        },
      }, { init: { signal } })
      // An optimistic entry is no longer needed once the server lists it.
      for (const e of page.entries) removeOptimistic(e.workspaceId)
      return page
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor,
    enabled: projectId !== null && opts.enabled,
    staleTime: 2000,
    // Keep the old rows while a new search or exclusion loads, so the list
    // changes in one step rather than flashing empty.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === projectId ? prev : undefined),
  })

  // Refetch the loaded pages when the snapshot's counts move. The first
  // value only records itself, since the query has just fetched.
  const { version } = opts
  const seen = useRef(version)
  const group = filter.group ?? ''
  useEffect(() => {
    if (seen.current === version) return
    seen.current = version
    // A fetch still in flight may predate the change, and an invalidation
    // would only wait for it, so cancel it first.
    const filters = { queryKey: ['stopped', projectId, q, group, excludeGroups, exclude], exact: true }
    void queryClient.cancelQueries(filters).then(() => queryClient.invalidateQueries(filters))
  }, [queryClient, projectId, q, group, excludeGroups, exclude, version])

  const { data, isPlaceholderData, isFetching, isFetchingNextPage, isError, fetchNextPage } = query
  const fetched = data?.pages.flatMap((p) => p.entries) ?? []
  const fetchedIds = new Set(fetched.map((e) => e.workspaceId))
  const excluded = new Set(filter.excludeGroups)
  const inFilter = (e: StoppedWorkspaceEntry): boolean => filter.group !== undefined
    ? e.groupId === filter.group
    : e.groupId === undefined || !excluded.has(e.groupId)
  const pending = q
    ? []
    : optimistic.filter((e) => e.projectId === projectId && !fetchedIds.has(e.workspaceId) && inFilter(e))
  return {
    entries: [...pending, ...fetched].filter((e) => !opts.hidden.has(e.workspaceId)),
    total: data?.pages[0]?.total,
    hasNextPage: query.hasNextPage && !isPlaceholderData,
    isFetching,
    isFetchingNextPage,
    settling: isPlaceholderData || (data === undefined && isFetching),
    isError,
    // Never restart a page already loading.
    fetchNextPage: () => { void fetchNextPage({ cancelRefetch: false }) },
  }
}

/**
 * How many workspaces the Stopped section lists, from the snapshot alone so
 * a collapsed section needs no fetch: every stop in the project, less those
 * drawn elsewhere. That is the members of groups showing their own ghosts
 * (`owning`), held workspaces, and restarts in flight (a restart keeps its
 * stop until it succeeds).
 */
export function stoppedSectionCount(
  project: { stoppedCount: number } | undefined,
  groups: Pick<WorkspaceGroupSummary, 'groupId' | 'stoppedCount'>[],
  owning: ReadonlySet<string>,
  held: Pick<HeldWorkspaceEntry, 'groupId'>[],
  provisioning: Pick<ProvisioningWorkspaceEntry, 'kind' | 'groupId'>[],
): number {
  const outside = (e: { groupId?: string }): boolean => e.groupId === undefined || !owning.has(e.groupId)
  const owned = groups.filter((g) => owning.has(g.groupId)).reduce((n, g) => n + g.stoppedCount, 0)
  const restarts = provisioning.filter((p) => p.kind === 'restart' && outside(p)).length
  return Math.max(0, (project?.stoppedCount ?? 0) - owned - held.filter(outside).length - restarts)
}

/**
 * One stopped workspace of the active project, for the main pane: from the
 * optimistic list or any loaded page at once, then fetched by id, so a deep
 * link to a workspace no page has loaded works too. An id from another
 * project finds nothing, since the pane's read-only state follows the
 * project being viewed. `pending` while that first fetch runs with nothing
 * to show. `version` refetches it when the project's stops change (it may
 * have been restarted and stopped again).
 */
export function useStoppedEntry(
  projectId: string | null,
  workspaceId: string | null,
  opts: { enabled: boolean; version: string },
): { entry: StoppedWorkspaceEntry | undefined; pending: boolean } {
  const queryClient = useQueryClient()
  const optimistic = useUiStore((s) => s.optimisticStopped)
    .find((e) => e.workspaceId === workspaceId && e.projectId === projectId)
  const enabled = opts.enabled && projectId !== null && workspaceId !== null
  const { data, isLoading } = useQuery({
    queryKey: ['stopped-entry', projectId, workspaceId, opts.version],
    queryFn: async () => (await api.workspace['list-stopped'].$get({
      query: { project: projectId ?? '', workspace: workspaceId ?? '' },
    })).entries[0] ?? null,
    enabled,
    placeholderData: () => cachedEntry(queryClient, projectId ?? '', workspaceId ?? ''),
  })
  if (!enabled) return { entry: undefined, pending: false }
  return { entry: data ?? optimistic, pending: isLoading && optimistic === undefined }
}

/**
 * Whether the server's search `q` matches one stopped workspace, by the same
 * predicate that fills the Stopped list, so a caller can tell whether that
 * list will show it without loading every page. Undefined until the first
 * answer; the previous answer for the same workspace stands while a new
 * query loads.
 */
export function useStoppedMatch(
  projectId: string | null,
  workspaceId: string | null,
  q: string,
  opts: { enabled: boolean; version: string },
): boolean | undefined {
  const enabled = opts.enabled && projectId !== null && workspaceId !== null && q !== ''
  const { data } = useQuery({
    queryKey: ['stopped-match', projectId, workspaceId, q, opts.version],
    queryFn: async ({ signal }) => (await api.workspace['list-stopped'].$get({
      query: { project: projectId ?? '', workspace: workspaceId ?? '', q, limit: '1' },
    }, { init: { signal } })).entries.length > 0,
    enabled,
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[2] === workspaceId ? prev : undefined),
  })
  return enabled ? data : undefined
}

function cachedEntry(queryClient: QueryClient, projectId: string, workspaceId: string): StoppedWorkspaceEntry | undefined {
  for (const [, data] of queryClient.getQueriesData<InfiniteData<StoppedWorkspacePage>>({ queryKey: ['stopped', projectId] })) {
    const hit = data?.pages.flatMap((p) => p.entries).find((e) => e.workspaceId === workspaceId)
    if (hit) return hit
  }
  return undefined
}

/** Patch every cached stopped list and entry of a project so a change (e.g.
 *  marking a death seen) shows before the server write returns. */
export function patchStopped(
  queryClient: QueryClient,
  projectId: string,
  patch: (e: StoppedWorkspaceEntry) => StoppedWorkspaceEntry,
): void {
  queryClient.setQueriesData<InfiniteData<StoppedWorkspacePage>>({ queryKey: ['stopped', projectId] }, (old) => old && {
    ...old,
    pages: old.pages.map((p) => ({ ...p, entries: p.entries.map(patch) })),
  })
  queryClient.setQueriesData<StoppedWorkspaceEntry | null>({ queryKey: ['stopped-entry', projectId] }, (old) =>
    old && patch(old))
}

/** Refetch every stopped list and entry of a project, e.g. to undo a
 *  `patchStopped` the server refused. */
export function refetchStopped(queryClient: QueryClient, projectId: string): void {
  void queryClient.invalidateQueries({ queryKey: ['stopped', projectId] })
  void queryClient.invalidateQueries({ queryKey: ['stopped-entry', projectId] })
}

/** Restart a stopped workspace in place: its provisioning row takes the
 *  stopped row's spot (and its group), and the selection stays on it. */
export function useRestartStopped(): (entry: StoppedWorkspaceEntry) => void {
  const provision = useProvisionWorkspace()
  const removeOptimistic = useUiStore((s) => s.removeOptimisticStopped)
  return (entry) => {
    removeOptimistic(entry.workspaceId)
    provision(entry.projectId, entry.tool, 'restart', entry.workspaceId,
      (sid, onProgress) => restartWorkspace(sid, onProgress),
      entry.groupId)
  }
}
