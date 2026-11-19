import type { JSX } from 'react'
import { cn } from './cn'
import { YLogoMark } from './YLogoMark'

/**
 * A session's state as a 14px mark: `need` (waiting for you), `fail`,
 * `work` (the logo stepping), `bg` (its turn ended but background work
 * still runs), `later` (scheduled), `done`, `stop` and `idle` (no mark).
 * Pair it with words where there is room; the mark carries a title for
 * where there is not.
 */
export type YStatusKind = 'need' | 'fail' | 'work' | 'bg' | 'later' | 'done' | 'stop' | 'idle'

const LABEL: Record<YStatusKind, string> = {
  need: 'Needs you', fail: 'Failed', work: 'Working', bg: 'Running in the background',
  later: 'Scheduled', done: 'Done', stop: 'Stopped', idle: 'Idle',
}

export function YStatus({ kind, title, className }: { kind: YStatusKind; title?: string; className?: string }): JSX.Element {
  return (
    <span
      role="img"
      aria-label={title ?? LABEL[kind]}
      title={title ?? LABEL[kind]}
      className={cn('inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center', className)}
    >
      {mark(kind)}
    </span>
  )
}

function mark(kind: YStatusKind): JSX.Element | null {
  switch (kind) {
    case 'need':
      return (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <rect x="1" y="1" width="12" height="12" fill="var(--warning)" />
          <path d="M5.25 5.35a1.8 1.8 0 1 1 2.5 1.65c-.5.22-.75.6-.75 1.05v.25" stroke="var(--on-warning)"
            strokeWidth="1.6" strokeLinecap="square" />
          <rect x="6.15" y="9.45" width="1.7" height="1.7" fill="var(--on-warning)" />
        </svg>
      )
    case 'fail':
      return (
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <rect x="1" y="1" width="12" height="12" fill="var(--danger)" />
          <path d="M7 3.6v4.2" stroke="var(--on-danger)" strokeWidth="1.7" />
          <rect x="6.15" y="9.2" width="1.7" height="1.7" fill="var(--on-danger)" />
        </svg>
      )
    case 'work':
      return <YLogoMark height={14} animation="step" className="text-info" />
    case 'bg':
      return (
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <rect x="2" y="2" width="10" height="10" fill="none" stroke="var(--info)" strokeWidth="1.5"
            strokeDasharray="2.5 2" />
        </svg>
      )
    case 'later':
      return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-subtle)" strokeWidth="2"
          strokeLinecap="round" aria-hidden="true">
          <path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0 M12 7v5l3 2" />
        </svg>
      )
    case 'done':
      return <span className="h-1.5 w-1.5 bg-text" />
    case 'stop':
      return <span className="h-[1.5px] w-[9px] bg-subtle" />
    case 'idle':
      return null
  }
}
