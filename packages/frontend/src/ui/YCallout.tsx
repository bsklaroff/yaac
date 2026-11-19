import type { JSX, ReactNode } from 'react'
import { WarningIcon } from '#lib/icons'
import { cn } from './cn'

/** A note a page leads with when something about it needs saying up front,
 *  such as a server that runs workspaces without a sandbox. */
export function YCallout({ title, children, className }: {
  title: ReactNode
  children?: ReactNode
  className?: string
}): JSX.Element {
  return (
    <div role="note" className={cn('flex gap-2 border-l-2 border-warning bg-warning-soft px-3 py-2 text-sm text-muted', className)}>
      <WarningIcon size={14} aria-hidden className="mt-0.5 shrink-0 text-warning" />
      <div className="min-w-0">
        <div className="font-medium text-warning">{title}</div>
        {children && <div className="mt-1">{children}</div>}
      </div>
    </div>
  )
}
