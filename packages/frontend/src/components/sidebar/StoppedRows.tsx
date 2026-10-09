import { useEffect, useRef, type JSX } from 'react'
import clsx from 'clsx'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronIcon, LoadingIcon } from '#lib/icons'
import { api } from '#lib/api'
import { patchStopped, refetchStopped, type StoppedList } from '#lib/useStoppedWorkspaces'
import { RowMenu } from '#components/sidebar/RowMenu'
import { StoppedWorkspaceRow } from '#components/sidebar/WorkspaceRows'

/**
 * A paged stopped list's rows, then a marker that loads the next page once
 * it scrolls into view. The observer's root is the viewport, but the
 * intersection is clipped by the scrolling sidebar, so the marker counts as
 * visible only when the list is scrolled to it.
 */
export function StoppedRows({ list }: { list: StoppedList }): JSX.Element {
  const marker = useRef<HTMLDivElement>(null)
  const { hasNextPage, isFetchingNextPage, isError } = list
  const fetchNext = useRef(list.fetchNextPage)
  fetchNext.current = list.fetchNextPage
  useEffect(() => {
    const el = marker.current
    if (!el || !hasNextPage || isFetchingNextPage || isError) return
    const observer = new IntersectionObserver((seen) => {
      if (seen.some((e) => e.isIntersecting)) fetchNext.current()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasNextPage, isFetchingNextPage, isError])

  return (
    <>
      {list.entries.map((d) => <StoppedWorkspaceRow key={d.workspaceId} entry={d} />)}
      <div ref={marker} aria-hidden="true" className="h-px" />
      {isFetchingNextPage && (
        <p className="flex items-center gap-1.5 px-4 py-2 text-xs text-text-faint">
          <LoadingIcon size={11} className="animate-spin" />
          Loading…
        </p>
      )}
      {isError && (
        <p className="px-4 py-2 text-xs text-text-faint">
          Stopped workspaces could not be loaded.{' '}
          <button type="button" onClick={list.fetchNextPage} className="underline hover:text-text-dim">
            Retry
          </button>
        </p>
      )}
    </>
  )
}

/**
 * The Stopped section at the bottom of the workspace list: a header with the
 * count and an unseen-death dot, and, expanded, the paged rows. Its `…` menu
 * marks every death in the project seen.
 */
export function StoppedSection({
  projectId,
  count,
  unseenDeaths,
  expanded,
  onExpandedChange,
  list,
}: {
  projectId: string
  /** How many it lists (from the snapshot, or the search's total). */
  count: number
  unseenDeaths: number
  expanded: boolean
  /** Absent while a search holds the section open. */
  onExpandedChange?: (expanded: boolean) => void
  list: StoppedList
}): JSX.Element | null {
  const queryClient = useQueryClient()
  const markAll = useMutation({
    mutationFn: () => api.workspace['mark-all-deaths-seen'].$post({ json: { projectId } }),
    onMutate: () => patchStopped(queryClient, projectId, (e) => (e.deathReason ? { ...e, seen: true } : e)),
    onError: () => refetchStopped(queryClient, projectId),
  })
  if (count === 0 && list.entries.length === 0) return null
  return (
    <div role="group" aria-label="Stopped workspaces" className="py-1">
      <div className="group relative">
        <button
          type="button"
          aria-expanded={expanded}
          disabled={onExpandedChange === undefined}
          onClick={() => onExpandedChange?.(!expanded)}
          className="flex w-full items-center gap-1 px-3 py-1 text-xs font-medium text-text-faint outline-none
            transition hover:text-text-dim group-hover:pr-9 max-md:py-2.5 max-md:pr-11 max-md:text-sm"
        >
          <ChevronIcon size={12} className={clsx('shrink-0 transition-transform', expanded && 'rotate-90')} />
          <span>Stopped</span>
          <span className="text-text-faint/70">{count}</span>
          {/* aria-hidden so it stays out of the button's name. */}
          {unseenDeaths > 0 && (
            <span
              aria-hidden="true"
              title={`${unseenDeaths} workspace${unseenDeaths > 1 ? 's' : ''} died unexpectedly`}
              className="ml-1 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
            />
          )}
          {markAll.error && <span className="ml-auto truncate text-danger">{markAll.error.message}</span>}
        </button>
        {unseenDeaths > 0 && (
          <RowMenu
            label="Stopped workspaces actions"
            position="right-2 top-0.5"
            items={[{ label: 'Mark all as read', onSelect: () => markAll.mutate() }]}
          />
        )}
      </div>
      {expanded && <StoppedRows list={list} />}
    </div>
  )
}
