import type { ComponentType, JSX, ReactNode } from 'react'
import clsx from 'clsx'

/**
 * Centered empty-state block: a soft icon badge, a title, an optional line of
 * help text, and an optional action (e.g. a New-session button). The outer
 * layout — full-height and centered for a pane, or inset at the top of a
 * list — is left to the caller via `className`.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: ComponentType<{ size?: number; className?: string }>
  title: string
  description?: ReactNode
  action?: ReactNode
  className?: string
}): JSX.Element {
  return (
    <div className={clsx('flex flex-col items-center justify-center gap-3 px-6 text-center', className)}>
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-border
        bg-surface-2/60 text-text-faint">
        <Icon size={22} />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-text-dim">{title}</p>
        {description && (
          <p className="mx-auto max-w-[15rem] text-xs leading-relaxed text-text-faint">{description}</p>
        )}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}
