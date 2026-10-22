import type { JSX } from 'react'
import clsx from 'clsx'
import { WarningIcon } from '#lib/icons'

/** Fractions past which a meter reads as high, then critical. */
const HIGH = 0.75
const CRITICAL = 0.9

/**
 * A used-of-capacity bar. The fill carries severity (link blue, then
 * warning, then danger) over a lighter track of the same hue. Light mode's
 * warning and danger are hard to tell apart, so a high meter also shows an
 * icon and its percentage in text; color is never the only signal.
 */
export function Meter({ used, capacity, label, className }: {
  used: number
  capacity: number
  /** What the meter measures, for screen readers. */
  label: string
  className?: string
}): JSX.Element {
  const fraction = capacity > 0 ? Math.min(1, used / capacity) : 0
  const severity = fraction >= CRITICAL ? 'critical' : fraction >= HIGH ? 'high' : 'normal'
  const percent = Math.round(fraction * 100)
  return (
    <div className={clsx('flex items-center gap-1.5', className)}>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={capacity}
        aria-valuenow={used}
        aria-valuetext={`${String(percent)}%${severity === 'normal' ? '' : `, ${severity}`}`}
        className={clsx(
          'h-1.5 min-w-12 flex-1 overflow-hidden rounded-sm',
          { normal: 'bg-link/20', high: 'bg-warning/20', critical: 'bg-danger/20' }[severity],
        )}
      >
        <div
          className={clsx(
            'h-full rounded-r',
            { normal: 'bg-link', high: 'bg-warning', critical: 'bg-danger' }[severity],
          )}
          style={{ width: `${String(fraction * 100)}%` }}
        />
      </div>
      <span className="flex w-10 shrink-0 items-center justify-end gap-0.5 text-[11px] tabular-nums text-text-dim">
        {severity !== 'normal' && (
          <WarningIcon
            size={10}
            className={severity === 'critical' ? 'text-danger' : 'text-warning'}
            aria-hidden
          />
        )}
        {percent}%
      </span>
    </div>
  )
}
