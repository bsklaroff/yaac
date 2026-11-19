import type { JSX } from 'react'
import { cn } from './cn'
import { YLogoMark } from './YLogoMark'

const TONE = { muted: 'text-muted', text: 'text-text', subtle: 'text-subtle' }

/** The page spinner: the mono logo drawing itself. The only loader for a
 *  page or pane; small inline waits use the working status instead. */
export function YLoader({ size = 32, tone = 'muted', label = 'Loading', className }: {
  size?: number
  tone?: keyof typeof TONE
  label?: string
  className?: string
}): JSX.Element {
  return (
    <span role="status" aria-label={label} className={cn('inline-flex', TONE[tone], className)}>
      <YLogoMark height={size} animation="draw" />
    </span>
  )
}
