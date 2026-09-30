import type { JSX, ReactNode } from 'react'
import { NavBackIcon } from '#lib/icons'

/**
 * Top bar of a mobile screen: optional back button, title, and actions.
 * Callers pass a back handler that goes through browser history, so the
 * button, Android back and iOS edge-swipe behave the same (see
 * `useMobileHistory` in #lib/mobileHistory).
 */
export function MobileHeader({
  onBack,
  backLabel,
  title,
  actions,
}: {
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
