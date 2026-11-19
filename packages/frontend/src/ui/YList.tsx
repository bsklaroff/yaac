import type { JSX, ReactNode } from 'react'
import { cn } from './cn'
import { ChevronIcon, RoutineIcon } from '#lib/icons'
import { YRowFrame, type YRowFrameProps } from './YRow'
import { YAvatar } from './YAvatar'

/*
 * Rows for the lists on Home, the sidebar and the settings pages, and the
 * heading that groups them. Each row is a YRowFrame: clickable as a whole
 * when given `onSelect`, with optional hover `actions`.
 */

/** A heading over a group of rows: its label and a count. `open` and
 *  `onToggle` make it collapse its group. */
export function YListSection({ label, count, open, onToggle, actions, className }: {
  label: ReactNode
  count?: number
  open?: boolean
  onToggle?: () => void
  actions?: ReactNode
  className?: string
}): JSX.Element {
  const heading = (
    <>
      {onToggle && (
        <ChevronIcon size={12} strokeWidth={2} aria-hidden className={cn('transition-transform', open && 'rotate-90')} />
      )}
      <span>{label}</span>
      {count !== undefined && <span className="tabular-nums text-subtle">{count}</span>}
    </>
  )
  return (
    <div className={cn('flex min-h-7 items-center gap-1.5 px-2.5 pt-3.5 pb-1 text-sm text-subtle', className)}>
      {onToggle ? (
        <button type="button" onClick={onToggle} aria-expanded={open}
          className="flex min-w-0 items-center gap-1.5 rounded-xs outline-none hover:text-text focus-visible:outline-2 focus-visible:outline-accent">
          {heading}
        </button>
      ) : <span className="flex min-w-0 items-center gap-1.5">{heading}</span>}
      {actions && <span className="ml-auto flex items-center gap-0.5">{actions}</span>}
    </div>
  )
}

/** A row in a list page: title, then on the right what it is doing, who
 *  owns it and how long ago. Rows are cut apart by a line. */
export function YListRow({ title, sub, person, time, leading, ...frame }: {
  title: ReactNode
  sub?: ReactNode
  person?: { id: string; name: string }
  time?: string
  leading?: ReactNode
} & Omit<YRowFrameProps, 'children'>): JSX.Element {
  return (
    <YRowFrame {...frame} className={cn('min-h-[34px] border-b border-line pr-1', frame.className)}>
      {leading}
      <span className="min-w-0 flex-1 truncate text-md text-text">{title}</span>
      {sub && <span className="shrink-0 truncate text-sm text-subtle">{sub}</span>}
      {person && <YAvatar id={person.id} name={person.name} size={18} />}
      {time && <span className="w-8 shrink-0 text-right text-sm tabular-nums text-subtle">{time}</span>}
    </YRowFrame>
  )
}

/** A routine: its name and what runs it. */
export function YRoutineRow({ name, trigger, paused = false, ...frame }: {
  name: ReactNode
  trigger: ReactNode
  paused?: boolean
} & Omit<YRowFrameProps, 'children'>): JSX.Element {
  return (
    <YRowFrame {...frame} className={cn('min-h-[34px] border-b border-line px-1', frame.className)}>
      <RoutineIcon size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-subtle" />
      <span className={cn('min-w-0 flex-1 truncate text-md', paused ? 'text-subtle' : 'text-text')}>{name}</span>
      <span className="shrink-0 truncate text-sm text-subtle">{trigger}</span>
    </YRowFrame>
  )
}

/** A person on the server: avatar, name and role, and on the right what
 *  they have running. */
export function YPersonRow({ id, name, role, meta, ...frame }: {
  id: string
  name: string
  role?: ReactNode
  meta?: ReactNode
} & Omit<YRowFrameProps, 'children' | 'label'> & { label?: string }): JSX.Element {
  return (
    <YRowFrame label={name} {...frame} className={cn('min-h-12 border-b border-line py-2', frame.className)}>
      <YAvatar id={id} name={name} size={30} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-md text-text">{name}</span>
        {role && <span className="truncate text-sm text-subtle">{role}</span>}
      </span>
      {meta && <span className="shrink-0 text-sm text-muted">{meta}</span>}
    </YRowFrame>
  )
}

/** One numbered step of a how-to: its number in a key cap, a title, and
 *  what to do. */
export function YStep({ n, title, children, done = false }: {
  n: number
  title: ReactNode
  children?: ReactNode
  done?: boolean
}): JSX.Element {
  return (
    <div className="flex gap-3">
      <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-xs tabular-nums shadow-inset',
        done ? 'bg-inverse text-on-inverse' : 'text-muted')}>{n}</span>
      <div className="min-w-0">
        <div className="text-md font-semibold text-text">{title}</div>
        {children && <div className="mt-0.5 text-md text-muted">{children}</div>}
      </div>
    </div>
  )
}
