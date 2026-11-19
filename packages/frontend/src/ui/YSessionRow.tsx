import type { JSX, ReactNode } from 'react'
import { cn } from './cn'
import { YRowFrame, type YRowFrameProps } from './YRow'
import { YStatus, type YStatusKind } from './YStatus'
import { identityFamily, identityInitial, identityStyle } from './identity'

/**
 * A session in the sidebar: its status, its title, and (on Home, where rows
 * span projects) its project. `sub` adds a second line saying what it needs
 * ("Wants to run pnpm install"). Rows that need you, failed, or finished
 * unseen are `strong`. `depth` indents a session listed under its
 * workspace on a 1px tree line.
 */
export function YSessionRow({ status, title, sub, project, strong = false, depth = 0, trailing, ...frame }: {
  status?: YStatusKind
  title: ReactNode
  sub?: ReactNode
  project?: { id: string; name: string }
  strong?: boolean
  depth?: number
  /** Small marks after the title (an unread dot, a count). */
  trailing?: ReactNode
} & Omit<YRowFrameProps, 'children'>): JSX.Element {
  const two = sub !== undefined
  return (
    <YRowFrame {...frame} className={cn(two ? 'py-2' : 'py-[7px]', 'pr-2', depth === 0 ? 'pl-2.5' : 'pl-7', frame.className)}>
      {depth > 0 && <span aria-hidden className="absolute -bottom-2 -top-2 -left-[11px] w-px bg-line" />}
      {/* A little closer than the frame's gap: the mark reads with its title. */}
      {status && <YStatus kind={status} className={cn('-mr-1', two && 'mt-px self-start')} />}
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className={cn('flex min-w-0 items-center gap-1.5 text-md',
          strong ? 'font-semibold text-text' : frame.selected ? 'text-text' : 'text-muted')}>
          <span className="min-w-0 truncate">{title}</span>
          {trailing}
        </span>
        {two && (
          <span className="flex min-w-0 items-center gap-1.5 text-sm text-subtle">
            {project && <ProjectDot {...project} />}
            <span className="truncate">{sub}</span>
          </span>
        )}
      </div>
      {!two && project && <ProjectDot {...project} />}
    </YRowFrame>
  )
}

/** A project as a 14px tile with its initial. */
function ProjectDot({ id, name }: { id: string; name: string }): JSX.Element {
  return (
    <span title={name} className="flex h-3.5 w-3.5 shrink-0 items-center justify-center font-semibold"
      style={{ ...identityStyle(identityFamily(id), false), fontSize: 9 }}>
      {identityInitial(name)}
    </span>
  )
}
