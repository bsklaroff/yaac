import type { JSX } from 'react'
import clsx from 'clsx'
import type { LineCounts } from '@yaac/shared/types'

/** `+12 −3`, each side shown only when nonzero. */
export function LineCountsLabel({ counts, className }: { counts: LineCounts; className?: string }): JSX.Element {
  return (
    <span className={clsx('shrink-0 font-mono tabular-nums', className)}>
      {counts.additions > 0 && <span className="text-success">+{counts.additions}</span>}
      {counts.additions > 0 && counts.deletions > 0 && ' '}
      {counts.deletions > 0 && <span className="text-error">−{counts.deletions}</span>}
    </span>
  )
}
