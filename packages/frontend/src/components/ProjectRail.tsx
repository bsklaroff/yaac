import type { JSX } from 'react'
import clsx from 'clsx'
import { NewProjectButton } from '#components/NewProjectButton'
import { SettingsButton } from '#components/SettingsButton'
import { WindowControls } from '#components/WindowControls'
import { isElectron } from '#lib/platform'
import { projectColor, projectInitial } from '#lib/projectIdentity'
import type { ProjectSummary } from '@yaac/shared/types'

/**
 * Discord/Slack-style left rail of projects — the top-level navigation
 * axis. The active project scopes the sidebar; a project with unread
 * waiting worktrees (awaiting input and not yet viewed) shows an attention
 * badge so "which project needs me" is visible before drilling in.
 */
export function ProjectRail({
  projects,
  activeProjectSlug,
  attentionBySlug,
  onSelect,
}: {
  projects: ProjectSummary[]
  activeProjectSlug: string | null
  attentionBySlug: Record<string, number>
  onSelect: (slug: string) => void
}): JSX.Element {
  return (
    <div className={clsx(
      // This 64px rail plus the 8px gap to the sidebar read as one region (the
      // sidebar's border is what bounds it), so the chips are centered in that
      // whole 72px region, not this column: pl-2 nudges them right to its
      // center. In Electron the custom window controls sit at the top, centered
      // the same way, so they line up with the chips.
      'flex w-16 shrink-0 flex-col items-center gap-2 pb-3 pl-2',
      isElectron() ? 'pt-2' : 'pt-3',
    )}>
      {isElectron() && <WindowControls className="h-5" />}
      {projects.map((p) => {
        const active = p.slug === activeProjectSlug
        const color = projectColor(p.slug)
        const waiting = attentionBySlug[p.slug] ?? 0
        return (
          <button
            key={p.slug}
            onClick={() => onSelect(p.slug)}
            className="group relative flex items-center justify-center"
            title={p.slug}
          >
            <span
              className={clsx(
                // Flush to the window's left edge (the chip sits ~16px in after
                // the region centering, so pull the bar back the same amount).
                'absolute left-0 -ml-4 w-0.5 rounded-r-full bg-text transition-all',
                active ? 'h-6' : 'h-0 group-hover:h-4',
              )}
            />
            <span
              className={clsx(
                'flex h-10 w-10 items-center justify-center text-[16px] font-semibold transition-all',
                active ? 'rounded-xl' : 'rounded-[20px] group-hover:rounded-xl',
              )}
              // Quiet identity treatment: a dark tint of the project hue for
              // the fill, a light pastel of it for the initial — active just
              // steps both up rather than going to a loud solid fill.
              style={{
                background: active
                  ? `color-mix(in oklab, ${color} 26%, var(--color-surface-2))`
                  : `color-mix(in oklab, ${color} 12%, var(--color-surface-2))`,
                color: active
                  ? `color-mix(in oklab, ${color} 40%, var(--color-text))`
                  : `color-mix(in oklab, ${color} 45%, var(--color-text-dim))`,
              }}
            >
              {projectInitial(p.slug)}
            </span>
            {waiting > 0 && (
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
