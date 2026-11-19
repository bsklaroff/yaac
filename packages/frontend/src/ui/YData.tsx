import { useState, type JSX, type KeyboardEvent, type ReactNode } from 'react'
import { WarningIcon } from '#lib/icons'
import { cn } from './cn'

/*
 * Numbers at a glance: a stat, a meter, a bar chart, and a machine's meters
 * together. Monochrome; a meter turns amber, then red, only as it fills.
 */

/** A count and what it counts. */
export function YStatCard({ value, label, className }: { value: ReactNode; label: ReactNode; className?: string }): JSX.Element {
  return (
    <div className={cn('flex min-w-[88px] flex-col gap-1 rounded-sm px-4 py-3 shadow-inset', className)}>
      <span className="text-xl font-semibold tabular-nums tracking-tight text-text">{value}</span>
      <span className="text-sm text-subtle">{label}</span>
    </div>
  )
}

/** How full something is: the label, a bar, and the percentage. `warnAt`
 *  and `dangerAt` (fractions) colour the bar as it fills, and past them a
 *  warning icon shows too, so colour is never the only signal. `name` is
 *  the meter's accessible name; it defaults to `label` when that is text. */
export function YMeter({ label, name, value, detail, warnAt = 0.8, dangerAt = 0.95, className }: {
  label: ReactNode
  name?: string
  /** 0 … 1. */
  value: number
  /** Replaces the percentage, e.g. "12 of 16 GB". */
  detail?: ReactNode
  warnAt?: number
  dangerAt?: number
  className?: string
}): JSX.Element {
  const v = Math.max(0, Math.min(1, value))
  const level = v >= dangerAt ? 'critical' : v >= warnAt ? 'high' : null
  const percent = Math.round(v * 100)
  return (
    <div className={cn('flex items-center gap-3 text-md', className)}>
      <span className="w-16 shrink-0 truncate text-muted">{label}</span>
      <span
        className="relative h-1 min-w-12 flex-1 bg-line"
        role="meter"
        aria-label={name ?? (typeof label === 'string' ? label : undefined)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={level ? `${percent}%, ${level}` : `${percent}%`}
      >
        <span className={cn('absolute inset-y-0 left-0', level === 'critical' ? 'bg-danger' : level ? 'bg-warning' : 'bg-muted')}
          style={{ width: `${v * 100}%` }} />
      </span>
      <span className="flex w-12 shrink-0 items-center justify-end gap-0.5 tabular-nums text-muted">
        {level && <WarningIcon size={11} aria-hidden className={level === 'critical' ? 'text-danger' : 'text-warning'} />}
        {detail ?? `${percent}%`}
      </span>
    </div>
  )
}

/** A small bar chart of recent values, oldest first; the last bar (now) is
 *  lighter. Bars scale to `max` (a capacity) or else the largest value.
 *  Hovering a bar, or arrow keys once it is focused, shows that bar's
 *  `labels` entry. `name` is the chart's accessible name. */
export function YBars({ values, labels, name, max, height = 40, className }: {
  values: readonly number[]
  labels?: readonly string[]
  name: string
  max?: number
  height?: number
  className?: string
}): JSX.Element {
  const [active, setActive] = useState<number | null>(null)
  const top = Math.max(max ?? 0, ...values) || 1
  const step = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const from = active ?? values.length - 1
    setActive(Math.max(0, Math.min(values.length - 1, from + (e.key === 'ArrowLeft' ? -1 : 1))))
  }
  const shown = active !== null ? labels?.[active] : undefined
  return (
    <div
      role="img"
      aria-label={name}
      tabIndex={0}
      onKeyDown={step}
      onFocus={() => setActive(values.length - 1)}
      onBlur={() => setActive(null)}
      onPointerMove={(e) => {
        const box = e.currentTarget.getBoundingClientRect()
        setActive(Math.max(0, Math.min(values.length - 1, Math.floor(((e.clientX - box.left) / box.width) * values.length))))
      }}
      onPointerLeave={() => setActive(null)}
      className={cn('relative flex items-end gap-0.5 outline-none focus-visible:outline-1 focus-visible:outline-accent', className)}
      style={{ height }}
    >
      {values.map((v, i) => (
        <span
          key={i}
          className={cn('min-w-1 flex-1', i === active ? 'bg-text' : i === values.length - 1 ? 'bg-muted' : 'bg-line-strong')}
          style={{ height: `${Math.max(v > 0 ? 6 : 2, (v / top) * 100)}%` }}
        />
      ))}
      {shown && (
        <span role="tooltip" className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2
          whitespace-nowrap bg-raised px-1.5 py-0.5 text-xs text-text shadow-raised">{shown}</span>
      )}
    </div>
  )
}

/** A machine: its name, how many sessions it runs, and its meters. */
export function YMachineCard({ name, sessions, meters, className }: {
  name: ReactNode
  sessions?: ReactNode
  meters: readonly { label: string; value: number; detail?: ReactNode }[]
  className?: string
}): JSX.Element {
  return (
    <div className={cn('flex flex-col gap-2 rounded-sm p-4 shadow-inset', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-md font-semibold text-text">{name}</span>
        {sessions !== undefined && <span className="shrink-0 text-sm text-subtle">{sessions}</span>}
      </div>
      {meters.map((m) => <YMeter key={m.label} {...m} />)}
    </div>
  )
}
