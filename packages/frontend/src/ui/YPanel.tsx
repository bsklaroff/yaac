import type { HTMLAttributes, JSX, ReactNode } from 'react'
import { cn } from './cn'

/*
 * A pane's frame. Panes sit flush, cut from their neighbours by 1px lines.
 */

/** A pane: its header (`header`, usually a YPanelHeader) over its body. */
export function YPanel({ header, children, className, bodyClassName }: {
  header?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}): JSX.Element {
  return (
    <section className={cn('flex min-h-0 min-w-0 flex-col bg-surface', className)}>
      {header}
      <div className={cn('relative min-h-0 flex-1', bodyClassName)}>{children}</div>
    </section>
  )
}

/** A pane's header row: its tabs on the left, its actions (pop out,
 *  expand, close) on the right. */
export function YPanelHeader({ tabs, actions, className }: { tabs?: ReactNode; actions?: ReactNode; className?: string }): JSX.Element {
  return (
    <div className={cn('flex h-10 shrink-0 items-center gap-1 border-b border-line px-1.5', className)}>
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">{tabs}</div>
      {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
    </div>
  )
}

/** A tab in a pane header: on the selected fill when active. Not a YTabs
 *  tab, because pane tabs are dragged between columns and carry their own
 *  close and menu controls (`children` after the label). */
export function YPanelTab({ active, label, icon, onSelect, children, className, ...rest }: {
  active: boolean
  label: ReactNode
  icon?: ReactNode
  onSelect: () => void
  children?: ReactNode
  className?: string
} & Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'children' | 'onSelect'>): JSX.Element {
  return (
    <div
      {...rest}
      role="tab"
      aria-selected={active}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect() } }}
      className={cn(
        'group/tab flex h-[26px] min-w-0 max-w-[220px] shrink-0 cursor-default select-none items-center gap-1.5 rounded-sm px-2.5',
        'text-md outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
        active ? 'bg-selected text-text' : 'text-subtle hover:text-text',
        className,
      )}
    >
      {icon}
      <span className="min-w-0 truncate">{label}</span>
      {children}
    </div>
  )
}
