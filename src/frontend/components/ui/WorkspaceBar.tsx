import { type JSX, type ReactNode } from 'react'
import clsx from 'clsx'

/**
 * The slim 32px strip that sits on the base layer above the workspace
 * panes (the panes are the cards; this bar is not). Shared by the Build
 * tab's session bar in all its states.
 */
export function WorkspaceBar({
  className,
  children,
}: {
  className?: string
  children: ReactNode
}): JSX.Element {
  return (
    <header className={clsx('flex h-8 shrink-0 items-center gap-2.5 px-2 text-xs', className)}>
      {children}
    </header>
  )
}

/** Bar title: takes the flexible middle, truncating. `dim` for placeholder
 *  states (e.g. a session still provisioning). */
export function WorkspaceBarTitle({
  dim = false,
  children,
}: {
  dim?: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <span className={clsx('min-w-0 flex-1 truncate font-medium', dim ? 'text-text-dim' : 'text-text')}>
      {children}
    </span>
  )
}

/**
 * Class string for the 24px icon buttons used in bars and headers.
 * Exported on its own so Base UI trigger elements (Menu.Trigger etc.)
 * can wear the same look — they must render their own element.
 */
export function barIconButtonClass(tone: 'faint' | 'dim' = 'faint'): string {
  return clsx(
    'flex h-6 w-6 shrink-0 items-center justify-center rounded transition disabled:opacity-40',
    tone === 'faint'
      ? 'text-text-faint hover:bg-surface-2 hover:text-text-dim'
      : 'text-text-dim hover:bg-surface-2 hover:text-text',
  )
}

export function BarIconButton({
  tone = 'faint',
  title,
  onClick,
  disabled = false,
  className,
  children,
}: {
  tone?: 'faint' | 'dim'
  /** Tooltip; also used as the aria-label. */
  title: string
  onClick: () => void
  disabled?: boolean
  className?: string
  children: ReactNode
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={clsx(barIconButtonClass(tone), className)}
    >
      {children}
    </button>
  )
}
