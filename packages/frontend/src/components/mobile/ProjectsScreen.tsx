import type { JSX } from 'react'
import { ChevronIcon } from '#lib/icons'
import { MobileHeader } from '#components/mobile/MobileHeader'
import { NewProjectButton } from '#components/NewProjectButton'
import { SettingsButton } from '#components/SettingsButton'
import { EmptyState } from '#components/ui/EmptyState'
import { projectColor, projectInitial } from '#lib/projectIdentity'
import type { ProjectSummary } from '@yaac/shared/types'

/**
 * The root mobile screen: a list of named project rows (the desktop rail's
 * letter chips need hover to show names), plus add-project and settings rows.
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
  /** Per-project count of workspaces waiting and not yet looked at. */
  attentionBySlug: Record<string, number>
  connected: boolean
  onSelect: (slug: string) => void
}): JSX.Element {
  return (
    <>
      <MobileHeader
        title="yaac"
        actions={!connected
          ? <span className="pr-1 text-xs text-amber-400">reconnecting…</span>
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
                // Same colors as the rail chip.
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
                  title={`${waiting} workspace${waiting > 1 ? 's' : ''} waiting for input`}
                  className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-amber-500
                    px-1.5 text-[11px] font-semibold tabular-nums text-black"
                >
                  {waiting}
                </span>
              )}
              {/* Marks the active project. */}
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
