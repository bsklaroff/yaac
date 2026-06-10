import { type CSSProperties, type JSX, type PointerEventHandler, type ReactNode } from 'react'
import clsx from 'clsx'

/**
 * The floating workspace card — the single container chrome for anything
 * that floats over the base layer: terminal panes (tiles + tabs modes)
 * and the Plan tab's doc/terminal panes. Sidebars and the rail are NOT
 * panes; they sit flush on the base layer.
 */
export function Pane({
  className,
  style,
  children,
}: {
  className?: string
  style?: CSSProperties
  children: ReactNode
}): JSX.Element {
  return (
    <section
      style={style}
      className={clsx(
        'flex flex-col overflow-hidden rounded-lg border border-white/[0.06] bg-surface',
        'shadow-[0_8px_24px_rgba(0,0,0,0.45)]',
        className,
      )}
    >
      {children}
    </section>
  )
}

/** Slim 28px title strip at the top of a Pane. `padded` can be turned off
 *  when the content brings its own horizontal padding (e.g. tab strips). */
export function PaneHeader({
  className,
  padded = true,
  onPointerDown,
  children,
}: {
  className?: string
  padded?: boolean
  onPointerDown?: PointerEventHandler<HTMLDivElement>
  children: ReactNode
}): JSX.Element {
  return (
    <div
      onPointerDown={onPointerDown}
      className={clsx('flex h-7 shrink-0 items-center gap-1.5', padded && 'px-2.5', className)}
    >
      {children}
    </div>
  )
}

/** Pane title text, sized/colored like the terminal pane headers. */
export function PaneTitle({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-text-dim">
      {children}
    </span>
  )
}

/** The dark inner block a terminal sits in (inside a Pane body): the
 *  bg-bg rounded inset that frames every xterm in the app. */
export function TerminalBlock({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="h-full w-full overflow-hidden rounded-md bg-bg px-2.5 py-1.5">
      {children}
    </div>
  )
}
