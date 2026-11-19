import type { JSX } from 'react'

/**
 * The warning an editor for a shared credential opens with: every thing the
 * edit reaches (a git credential's repos, an endpoint's tools), so a
 * change made from one row is never a surprise to the others.
 */
export function AffectsBanner({ lead, names, none, note }: {
  /** What precedes the list, e.g. "Used by". */
  lead: string
  names: string[]
  /** Shown instead when nothing is affected. */
  none: string
  /** Shown after the list. */
  note?: string
}): JSX.Element {
  return (
    <p role="note" className="border-l-2 border-warning bg-warning-soft px-2.5 py-1.5 text-sm leading-relaxed text-muted">
      {names.length === 0 ? none : (
        <>
          {lead}{' '}
          {names.map((n, i) => (
            <span key={n}>
              {i > 0 && (i === names.length - 1 ? ' and ' : ', ')}
              <strong className="font-medium text-text">{n}</strong>
            </span>
          ))}
          .{note !== undefined && ` ${note}`}
        </>
      )}
    </p>
  )
}
