import type { HTMLAttributes, JSX, ReactNode } from 'react'
import { cn } from './cn'
import { ChevronIcon } from '#lib/icons'

/*
 * A pane's frame and the Details pane's cards. Panes sit flush, cut from
 * their neighbours by 1px lines.
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

/** The Details pane: its cards, then what to do with the session at the
 *  foot (`footer`). */
export function YDetailsPanel({ children, footer, className }: { children: ReactNode; footer?: ReactNode; className?: string }): JSX.Element {
  return (
    <div className={cn('flex h-full flex-col', className)}>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">{children}</div>
      {footer && <div className="flex shrink-0 items-center gap-2 border-t border-line p-3">{footer}</div>}
    </div>
  )
}

/** A card in the Details pane. With `onToggle` its title collapses it;
 *  `summary` says what is inside while it is closed ("+212 −48",
 *  "1 blocked host"), in `tone` when it needs attention. */
export function YDetailCard({ title, open = true, onToggle, summary, tone, children, className }: {
  title: ReactNode
  open?: boolean
  onToggle?: () => void
  summary?: ReactNode
  tone?: 'warning' | 'danger'
  children?: ReactNode
  className?: string
}): JSX.Element {
  const toneClass = tone === 'warning' ? 'text-warning' : tone === 'danger' ? 'text-danger' : 'text-muted'
  return (
    <div className={cn('rounded-sm shadow-inset', className)}>
      <div className="flex min-h-9 items-center gap-2 px-3">
        {onToggle ? (
          <button type="button" onClick={onToggle} aria-expanded={open}
            className="flex min-w-0 items-center gap-1 text-md font-semibold text-text outline-none focus-visible:outline-2 focus-visible:outline-accent">
            {title}
            <ChevronIcon size={12} strokeWidth={2} aria-hidden className={cn('text-subtle transition-transform', open && 'rotate-90')} />
          </button>
        ) : <span className="text-md font-semibold text-text">{title}</span>}
        {summary !== undefined && <span className={cn('ml-auto truncate text-md', toneClass)}>{summary}</span>}
      </div>
      {open && children !== undefined && <div className="flex flex-col gap-1 px-3 pb-3">{children}</div>}
    </div>
  )
}

/** A line in a Details card: an icon, what it says, a quieter note, and an
 *  action on the right. */
export function YDetailRow({ icon, children, note, action, tone, title }: {
  icon?: ReactNode
  children: ReactNode
  note?: ReactNode
  action?: ReactNode
  tone?: 'warning' | 'danger'
  /** The full text, for a row its width truncates. */
  title?: string
}): JSX.Element {
  return (
    <div title={title} className={cn('flex min-h-6 min-w-0 items-center gap-2 text-md',
      tone === 'warning' ? 'text-warning' : tone === 'danger' ? 'text-danger' : 'text-text')}>
      {icon && <span className="flex w-3.5 shrink-0 justify-center text-subtle">{icon}</span>}
      <span className="min-w-0 truncate">{children}</span>
      {note && <span className="min-w-0 truncate text-subtle">{note}</span>}
      {action && <span className="ml-auto shrink-0">{action}</span>}
    </div>
  )
}
