import type { JSX, ReactNode } from 'react'
import { cn } from './cn'

/**
 * A read-only state word on a soft tint: "Waiting for you", "Failed",
 * "+2 added". `dot` leads with a square of the tone's colour. Colour is for
 * state only, so `neutral` is the default.
 */
export type YBadgeTone = 'neutral' | 'warning' | 'info' | 'success' | 'danger' | 'accent'

const TONE: Record<YBadgeTone, string> = {
  neutral: 'bg-selected text-muted',
  warning: 'bg-warning-soft text-warning',
  info: 'bg-info-soft text-info',
  success: 'bg-success-soft text-success',
  danger: 'bg-danger-soft text-danger',
  accent: 'bg-accent-soft text-accent',
}

export function YBadge({ tone = 'neutral', dot = false, title, className, children }: {
  tone?: YBadgeTone
  dot?: boolean
  title?: string
  className?: string
  children: ReactNode
}): JSX.Element {
  return (
    <span
      title={title}
      className={cn('inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xs px-1.5 text-xs font-medium',
        TONE[tone], className)}
    >
      {dot && <span aria-hidden className="h-1.5 w-1.5 bg-current" />}
      {children}
    </span>
  )
}
