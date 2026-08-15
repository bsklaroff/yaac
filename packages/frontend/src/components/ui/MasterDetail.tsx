import type { JSX, ReactNode } from 'react'
import clsx from 'clsx'
import { NavBackIcon } from '#lib/icons'

/**
 * The two-pane body the full-screen overlays share (skills, stopped worktrees,
 * image builds): a fixed-width master list beside a detail pane that fills the
 * rest.
 *
 * Below md there is no room for both — a 20rem list next to a detail pane
 * leaves the detail a few dozen pixels — so the two panes become one screen
 * deep: the list gets the whole overlay until a row is picked, then the detail
 * takes over with a back chevron to the list. Both stay mounted and only the
 * off-screen one is hidden, so going back doesn't refetch or lose scroll.
 *
 * `detailOpen` is the caller's "the user picked a row" bit, not "a row is
 * selected" — every one of these overlays auto-selects its first row so the
 * desktop detail pane is never blank, and that auto-pick must not count as a
 * navigation on a phone.
 *
 * The detail pane is floored at `min-w-0` because a flex item's automatic
 * minimum size is its content's, and what these panes show is exactly the
 * content that has none worth honoring: a conversation's source lines, diffs
 * and fenced blocks are `white-space: pre`, so the column would size itself to
 * the widest line in the transcript, run off the right of the overlay and take
 * the actions at its foot with it. Floored, each of those blocks scrolls
 * inside its own scroller, which is where a long line belongs.
 */
export function MasterDetail({
  detailOpen,
  onBack,
  backLabel = 'Back to list',
  master,
  detail,
}: {
  detailOpen: boolean
  /** Mobile back chevron — clears the caller's selection. */
  onBack: () => void
  backLabel?: string
  master: ReactNode
  detail: ReactNode
}): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 gap-3 max-md:gap-0">
      <div className={clsx(
        'flex w-80 min-h-0 shrink-0 flex-col gap-2 max-md:w-full',
        detailOpen && 'max-md:hidden',
      )}>
        {master}
      </div>
      <div className={clsx(
        'flex min-h-0 min-w-0 flex-1 flex-col gap-2',
        !detailOpen && 'max-md:hidden',
      )}>
        <button
          type="button"
          onClick={onBack}
          aria-label={backLabel}
          title={backLabel}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-dim
            transition active:bg-surface-2 md:hidden"
        >
          <NavBackIcon size={18} />
        </button>
        {detail}
      </div>
    </div>
  )
}
