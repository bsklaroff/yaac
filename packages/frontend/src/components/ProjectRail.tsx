import type { JSX } from 'react'
import clsx from 'clsx'
import { NewProjectButton } from '#components/NewProjectButton'
import { SettingsButton } from '#components/SettingsButton'
import { UserSwitcher } from '#components/UserSwitcher'
import { WindowControls } from '#components/WindowControls'
import { LoadingIcon, WarningIcon } from '#lib/icons'
import { isElectron } from '#lib/platform'
import { projectColor, projectInitial } from '#lib/projectIdentity'
import type { ProjectOp } from '#lib/store'
import type { ProjectSummary } from '@yaac/shared/types'

/**
 * Left rail: the user switcher, then the viewed user's project chips. The
 * active project scopes the sidebar; a project with unviewed workspaces
 * waiting for input shows a dot. A project being added or removed (`ops`)
 * shows a spinner, or a warning once its request failed.
 */
export function ProjectRail({
  projects,
  ops,
  activeProjectId,
  attentionByProject,
  onSelect,
}: {
  projects: ProjectSummary[]
  ops: ProjectOp[]
  activeProjectId: string | null
  attentionByProject: Record<string, number>
  onSelect: (projectId: string) => void
}): JSX.Element {
  return (
    <div className={clsx(
      // pl-2 centers the chips in the rail plus the 8px gap to the sidebar,
      // which read as one region.
      'flex w-16 shrink-0 flex-col items-center gap-2 pb-3 pl-2',
      isElectron() ? 'pt-2' : 'pt-3',
    )}>
      {isElectron() && <WindowControls className="h-5" />}
      <UserSwitcher />
      {[...projects, ...ops.filter((o) => o.kind === 'add')].map((p) => {
        const op = ops.find((o) => o.id === p.id)
        const active = p.id === activeProjectId
        const color = projectColor(p.id)
        const waiting = attentionByProject[p.id] ?? 0
        return (
          <button
            key={p.id}
            onClick={() => onSelect(p.id)}
            className="group relative flex items-center justify-center"
            title={p.name}
          >
            <span
              className={clsx(
                // -ml-4 pulls the bar flush to the window's left edge.
                'absolute left-0 -ml-4 w-0.5 rounded-r-full bg-text transition-all',
                active ? 'h-6' : 'h-0 group-hover:h-4',
              )}
            />
            <span
              className={clsx(
                'flex h-10 w-10 items-center justify-center text-[16px] font-semibold transition-all',
                active ? 'rounded-xl' : 'rounded-[20px] group-hover:rounded-xl',
              )}
              // Muted tints of the project color; active is slightly stronger.
              style={{
                background: active
                  ? `color-mix(in oklab, ${color} 26%, var(--color-surface-2))`
                  : `color-mix(in oklab, ${color} 12%, var(--color-surface-2))`,
                color: active
                  ? `color-mix(in oklab, ${color} 40%, var(--color-text))`
                  : `color-mix(in oklab, ${color} 45%, var(--color-text-dim))`,
              }}
            >
              {op === undefined
                ? projectInitial(p.name)
                : op.error === undefined
                  ? <LoadingIcon size={18} className="animate-spin" aria-label={`${op.kind === 'add' ? 'Adding' : 'Removing'} project`} />
                  : <WarningIcon size={18} className="text-danger" aria-label="Failed" />}
            </span>
            {waiting > 0 && op === undefined && (
              <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-base" />
            )}
          </button>
        )
      })}

      <NewProjectButton />

      <div className="flex-1" />
      <SettingsButton />
    </div>
  )
}
