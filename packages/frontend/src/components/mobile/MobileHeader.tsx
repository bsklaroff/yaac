import type { JSX, ReactNode } from 'react'
import { NavBackIcon } from '#lib/icons'
import { YButton } from '#ui'

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
    <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line pl-1 pr-2">
      {onBack && (
        <YButton
          variant="ghost"
          icon={NavBackIcon}
          onClick={onBack}
          aria-label={backLabel ?? 'Back'}
          title={backLabel ?? 'Back'}
          className="max-md:h-9 max-md:w-9"
        />
      )}
      <div className="flex min-w-0 flex-1 items-center pl-1.5 text-base font-semibold tracking-tight">
        {title}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </header>
  )
}
