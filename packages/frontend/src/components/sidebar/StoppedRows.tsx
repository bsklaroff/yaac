import { useEffect, useRef, type JSX } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { LoadingIcon } from '#lib/icons'
import { api } from '#lib/api'
import { patchStopped, refetchStopped, type StoppedList } from '#lib/useStoppedWorkspaces'
import { useWhoami } from '#lib/viewer'
import { RowMenu } from '#components/sidebar/RowMenu'
import { StoppedWorkspaceRow } from '#components/sidebar/WorkspaceRows'
import { YButton, YListSection } from '#ui'

/**
 * A paged stopped list's rows, then a marker that loads the next page once
 * it scrolls into view. The observer's root is the viewport, but the
 * intersection is clipped by the scrolling sidebar, so the marker counts as
 * visible only when the list is scrolled to it. It is watched only while no
 * fetch is in flight, so pages load one at a time; observing again after a
 * fetch reports a marker still in view, which loads the next.
 */
export function StoppedRows({ list }: { list: StoppedList }): JSX.Element {
  const marker = useRef<HTMLDivElement>(null)
  const { hasNextPage, isFetching, isFetchingNextPage, isError } = list
  const fetchNext = useRef(list.fetchNextPage)
  fetchNext.current = list.fetchNextPage
  useEffect(() => {
    const el = marker.current
    if (!el || !hasNextPage || isFetching || isError) return
    const observer = new IntersectionObserver((seen) => {
      if (seen.some((e) => e.isIntersecting)) fetchNext.current()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasNextPage, isFetching, isError])

  return (
    <>
      {list.entries.map((d) => <StoppedWorkspaceRow key={d.workspaceId} entry={d} />)}
      <div ref={marker} aria-hidden="true" className="h-px" />
      {isFetchingNextPage && (
        <p className="flex items-center gap-1.5 px-4 py-2 text-md text-subtle">
          <LoadingIcon size={11} className="animate-spin" />
          Loading…
        </p>
      )}
      {isError && (
        <p className="px-4 py-2 text-md text-subtle">
          Stopped workspaces could not be loaded.{' '}
          <YButton variant="ghost" size="sm" onClick={list.fetchNextPage}>Retry</YButton>
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
  /** How many it lists, from the snapshot. */
  count: number
  unseenDeaths: number
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  list: StoppedList
}): JSX.Element | null {
  const queryClient = useQueryClient()
  const me = useWhoami()?.userId
  const markAll = useMutation({
    mutationFn: () => api.workspace['mark-all-deaths-seen'].$post({ json: { projectId } }),
    onMutate: () => patchStopped(queryClient, projectId, (e) => (
      e.deathReason && me !== undefined ? { ...e, deathSeenBy: [...e.deathSeenBy, me] } : e)),
    onError: () => refetchStopped(queryClient, projectId),
  })
  if (count === 0 && list.entries.length === 0) return null
  return (
    <div role="group" aria-label="Stopped workspaces" className="py-1">
      <YListSection
        className="group/row"
        label={(
          <span className="flex min-w-0 items-center gap-1.5">
            Stopped
            <span className="tabular-nums text-subtle">{count}</span>
            {/* aria-hidden so it stays out of the button's name. */}
            {unseenDeaths > 0 && (
              <span
                aria-hidden="true"
                title={`${unseenDeaths} workspace${unseenDeaths > 1 ? 's' : ''} died unexpectedly`}
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
              />
            )}
            {markAll.error && <span className="truncate text-danger">{markAll.error.message}</span>}
          </span>
        )}
        open={expanded}
        onToggle={() => onExpandedChange(!expanded)}
        actions={unseenDeaths > 0 && (
          <RowMenu
            label="Stopped workspaces actions"
            hoverOnly
            items={[{ label: 'Mark all as read', onSelect: () => markAll.mutate() }]}
          />
        )}
      />
      {expanded && <StoppedRows list={list} />}
    </div>
  )
}
