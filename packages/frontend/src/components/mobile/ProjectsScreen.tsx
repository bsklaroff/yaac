import type { JSX } from 'react'
import { ChevronIcon } from '#lib/icons'
import { MobileHeader } from '#components/mobile/MobileHeader'
import { NewProjectButton } from '#components/NewProjectButton'
import { SettingsButton } from '#components/SettingsButton'
import { EmptyState } from '#components/ui/EmptyState'
import { projectColor, projectInitial } from '#lib/projectIdentity'
import type { ProjectSummary } from '@yaac/shared/types'

/**
 * The root mobile screen: which project do you want to work in.
 *
 * Not the desktop rail scaled up. The rail's 40px chips are a *dense*
 * representation — they work because they sit beside the thing they scope, and
 * hovering one gives you its name. As the only content on a phone screen they
 * would be a column of unlabelled letters, so this is a plain list of named
 * rows carrying the same identity color, with the rail's footer affordances
 * (add project, settings) as rows of their own.
 */
export function ProjectsScreen({
  projects,
  activeProjectSlug,
  attentionBySlug,
  connected,
  onSelect,
}: {
  projects: ProjectSummary[]
  activeProjectSlug: string | null
  /** Per-project count of worktrees waiting and not yet looked at. */
  attentionBySlug: Record<string, number>
  connected: boolean
  onSelect: (slug: string) => void
}): JSX.Element {
  return (
    <>
      <MobileHeader
        title="yaac"
        actions={!connected
          ? <span className="pr-1 text-xs text-amber-400/80">reconnecting…</span>
          : undefined}
      />

      <div className="flex-1 overflow-y-auto p-2">
        {projects.length === 0 && (
          <EmptyState
            compact
            className="py-12"
            title="No projects yet"
            description="Add one by cloning a git repo."
          />
        )}
        {projects.map((p) => {
          const color = projectColor(p.slug)
          const waiting = attentionBySlug[p.slug] ?? 0
          return (
            <button
              key={p.slug}
              onClick={() => onSelect(p.slug)}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition
                active:bg-surface-2"
            >
              <span
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[15px] font-semibold"
                // Same quiet identity treatment as the rail chip: a dark tint
                // of the project hue, a light pastel of it for the initial.
                style={{
                  background: `color-mix(in oklab, ${color} 22%, var(--color-surface-2))`,
                  color: `color-mix(in oklab, ${color} 42%, var(--color-text))`,
                }}
              >
                {projectInitial(p.slug)}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">{p.slug}</span>
              {waiting > 0 && (
                <span
                  title={`${waiting} worktree${waiting > 1 ? 's' : ''} waiting for input`}
                  className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-amber-500
                    px-1.5 text-[11px] font-semibold tabular-nums text-black"
                >
                  {waiting}
                </span>
              )}
              {/* The active project keeps a quiet marker so returning to this
                  screen shows where you came from. */}
              {p.slug === activeProjectSlug && waiting === 0 && (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-text-faint" aria-hidden />
              )}
              <ChevronIcon size={16} className="shrink-0 text-text-faint" />
            </button>
          )
        })}

        <div className="mt-2 border-t border-hairline pt-2">
          <NewProjectButton variant="row" />
          <SettingsButton variant="row" />
        </div>
      </div>
    </>
  )
}
