import type { JSX, ReactNode } from 'react'
import { cn } from './cn'

/*
 * How a page or pane body is laid out: a scrolling column of readable
 * width, cut into titled sections, with settings as label-and-control rows.
 * The create screen, the routine, workflow and site panes, and settings all
 * compose from these, so they read alike.
 */

/** A page body: a scrolling area holding a centred column. */
export function YPageBody({ children, width = 'md', className }: {
  children: ReactNode
  /** md (720px) for forms and settings, lg (960px) for lists and grids. */
  width?: 'md' | 'lg'
  className?: string
}): JSX.Element {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className={cn('mx-auto flex w-full flex-col gap-8 px-8 py-6 max-md:px-4', width === 'md' ? 'max-w-[720px]' : 'max-w-[960px]',
        className)}>
        {children}
      </div>
    </div>
  )
}

/** A titled part of a page: its heading, a line saying what it is for, its
 *  actions on the right, then its content. */
export function YSection({ title, description, actions, children, className }: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  className?: string
}): JSX.Element {
  return (
    <section className={cn('flex flex-col gap-3', className)}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-text">{title}</h2>
          {description && <p className="mt-0.5 text-md text-muted">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

/** A group of setting rows, cut apart by lines inside an inset frame. */
export function YSettingGroup({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  return <div className={cn('flex flex-col divide-y divide-line rounded-sm shadow-inset', className)}>{children}</div>
}

/** One setting: what it is and a hint on the left, its control on the
 *  right. `stacked` puts a wide control (a list, an editor) under the label;
 *  `dense` tightens the row for a form that should fit one screen. */
export function YSettingRow({ label, hint, children, stacked = false, dense = false, className }: {
  label: ReactNode
  hint?: ReactNode
  children?: ReactNode
  stacked?: boolean
  dense?: boolean
  className?: string
}): JSX.Element {
  return (
    <div className={cn('flex gap-4 px-4', dense ? 'py-1.5' : 'py-3',
      stacked ? 'flex-col gap-2' : 'items-center max-md:flex-col max-md:items-stretch', className)}>
      <div className="min-w-0 flex-1">
        <div className="text-md font-medium text-text">{label}</div>
        {hint && <div className="mt-0.5 text-sm text-subtle">{hint}</div>}
      </div>
      {children !== undefined && <div className={cn('min-w-0', stacked ? 'w-full' : 'shrink-0')}>{children}</div>}
    </div>
  )
}
