import type { JSX, ReactNode } from 'react'
import { NavBackIcon } from '#lib/icons'

/**
 * The bar at the top of a mobile screen: an optional back chevron, a title
 * that takes whatever width is left, and a right-hand action cluster.
 *
 * Back goes through `history.back()` rather than setting the screen directly,
 * so the header chevron, the Android back button and the iOS edge-swipe are
 * all literally the same navigation — see MobileShell, which owns the history
 * entries.
 */
export function MobileHeader({
  onBack,
  backLabel,
  title,
  actions,
}: {
  /** Omitted on the root screen, which has nothing to go back to. */
  onBack?: () => void
  backLabel?: string
  title: ReactNode
  actions?: ReactNode
}): JSX.Element {
  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b border-hairline pl-1 pr-2">
      {onBack && (
        <button
          onClick={onBack}
          aria-label={backLabel ?? 'Back'}
          title={backLabel ?? 'Back'}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-dim
            transition active:bg-surface-2"
        >
          <NavBackIcon size={18} />
        </button>
      )}
      <div className="flex min-w-0 flex-1 items-center pl-1.5 text-sm font-semibold tracking-tight">
        {title}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </header>
  )
}
