import type { ComponentType, JSX, ReactNode } from 'react'
import clsx from 'clsx'

/**
 * Centered empty-state block: icon, title, optional hint and optional action.
 * The caller positions it via `className`. `compact` drops the icon and
 * shrinks the text for tight spots such as the sidebar list.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  compact = false,
  className,
}: {
  icon?: ComponentType<{ size?: number; className?: string }>
  title: string
  description?: ReactNode
  action?: ReactNode
  compact?: boolean
  className?: string
}): JSX.Element {
  return (
    <div className={clsx(
      'flex flex-col items-center justify-center text-center',
      compact ? 'gap-1 px-4' : 'gap-3 px-6',
      className,
    )}>
      {Icon && !compact && (
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-border
          bg-surface-2/60 text-text-faint">
          <Icon size={22} />
        </div>
      )}
      <div className="space-y-1">
        <p className={clsx('font-medium text-text-dim', compact ? 'text-xs' : 'text-sm')}>{title}</p>
        {description && (
          <p className="mx-auto max-w-[15rem] text-xs leading-relaxed text-text-faint">{description}</p>
        )}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}
