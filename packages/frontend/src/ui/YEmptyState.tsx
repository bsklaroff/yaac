import type { JSX, ReactNode } from 'react'
import { cn } from './cn'
import type { YIconGlyph } from './types'
import { YLoader } from './YLoader'
import { YLogoMark } from './YLogoMark'

/**
 * What a region shows when it has nothing yet: a mark, a title, an optional
 * line of explanation and an optional action. The mark is the loader while
 * something is on its way, the colour logo for a welcome, or an icon.
 * `compact` drops the mark and shrinks the text for tight spots such as a
 * sidebar list. The caller positions it with `className`.
 */
export function YEmptyState({ mark, icon: IconGlyph, title, description, action, compact = false, className }: {
  mark?: 'loader' | 'logo'
  icon?: YIconGlyph
  title: string
  description?: ReactNode
  action?: ReactNode
  compact?: boolean
  className?: string
}): JSX.Element {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center', compact ? 'gap-1 px-4' : 'gap-3 px-6',
      className)}>
      {!compact && mark === 'loader' && <YLoader size={28} />}
      {!compact && mark === 'logo' && <YLogoMark height={40} colour />}
      {!compact && mark === undefined && IconGlyph && (
        <IconGlyph size={22} strokeWidth={1.5} aria-hidden className="text-subtle" />
      )}
      <div className="space-y-1">
        <p className={cn('font-semibold text-text', compact ? 'text-md' : 'text-base')}>{title}</p>
        {description && <p className="mx-auto max-w-[22rem] text-md text-muted">{description}</p>}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}
