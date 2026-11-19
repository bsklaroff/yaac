import type { HTMLAttributes, JSX, ReactNode } from 'react'
import { cn } from './cn'

/**
 * The frame every clickable list row shares. The whole row is one button
 * (`onSelect`, labelled by `label`), drawn under the content so a row can
 * also hold its own controls: `actions` sit above that button and show on
 * hover, focus or while `actionsShown`. Content that carries a `title`
 * stays hoverable, so its full text still shows. Rows that are not
 * clickable omit `onSelect`. `rowProps` reach the outer element, for drag
 * and context menus.
 */
export interface YRowFrameProps {
  label: string
  onSelect?: () => void
  selected?: boolean
  actions?: ReactNode
  actionsShown?: boolean
  className?: string
  rowProps?: Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'children'>
  children: ReactNode
}

export function YRowFrame({ label, onSelect, selected = false, actions, actionsShown = false, className, rowProps, children }: YRowFrameProps): JSX.Element {
  return (
    <div
      {...rowProps}
      data-selected={selected || undefined}
      className={cn('group/row relative flex min-w-0 items-center', selected ? 'bg-selected' : onSelect && 'hover:bg-hover',
        className)}
    >
      {onSelect && (
        <button
          type="button"
          aria-label={label}
          aria-current={selected || undefined}
          onClick={onSelect}
          className="absolute inset-0 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        />
      )}
      {/* Clicks fall through to the row's button, except on what carries a
          title, which stays hoverable and selects the row itself. */}
      <div
        onClick={onSelect && ((e) => { if (!(e.target as Element).closest('button, a, [role="button"]')) onSelect() })}
        className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-2.5 [&_[title]]:pointer-events-auto"
      >
        {children}
      </div>
      {actions && (
        <div className={cn('relative flex shrink-0 items-center gap-0.5',
          !actionsShown && 'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100')}>
          {actions}
        </div>
      )}
    </div>
  )
}
