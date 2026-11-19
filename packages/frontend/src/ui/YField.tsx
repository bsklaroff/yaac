import type { JSX, ReactNode } from 'react'
import { cn } from './cn'

/** A labelled setting: the label, a muted hint, then the control. */
export function YField({ label, hint, className, children }: {
  label: ReactNode
  hint?: ReactNode
  className?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className={cn('mt-6', className)}>
      <div className="text-md font-medium text-text">{label}</div>
      {hint && <p className="mt-0.5 text-sm text-subtle">{hint}</p>}
      <div className="mt-2">{children}</div>
    </div>
  )
}

/** A small heading over a group of rows or fields. */
export function YSectionLabel({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  return <div className={cn('text-sm font-medium text-subtle', className)}>{children}</div>
}
