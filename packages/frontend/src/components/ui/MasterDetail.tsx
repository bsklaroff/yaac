import type { JSX, ReactNode } from 'react'
import clsx from 'clsx'
import { NavBackIcon } from '#lib/icons'

/**
 * The list-beside-detail body shared by the full-screen overlays (skills,
 * stopped workspaces, image builds).
 *
 * On small screens only one pane shows: the list until a row is picked, then
 * the detail with a back chevron. Both stay mounted so going back keeps
 * scroll and data.
 *
 * `detailOpen` means the user picked a row, not that one is selected: the
 * overlays auto-select a row for desktop, and that must not navigate on a
 * phone.
 *
 * The detail pane is `min-w-0` so wide `white-space: pre` content (diffs,
 * code blocks) scrolls in its own box instead of widening the column.
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
