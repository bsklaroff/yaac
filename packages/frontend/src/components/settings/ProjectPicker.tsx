import type { JSX } from 'react'
import clsx from 'clsx'
import type { ProjectSummary } from '@yaac/shared/types'
import { useSnapshot } from '#lib/useSnapshot'
import { useUiStore } from '#lib/store'
import { projectsOf, useViewedUserId } from '#lib/viewer'

/**
 * The project the project-scoped settings sections show, picked among the
 * viewed user's projects (#lib/viewer) and defaulting to the active one.
 * The pick lives in the store, so switching sections keeps it; closing
 * settings clears it.
 */
export function useSettingsProject(): {
  projects: ProjectSummary[]
  selected: ProjectSummary | undefined
  pick: (projectId: string) => void
} {
  const projects = projectsOf(useSnapshot()?.projects ?? [], useViewedUserId())
  const activeProjectId = useUiStore((s) => s.activeProjectId)
  const picked = useUiStore((s) => s.settingsProjectId)
  const pick = useUiStore((s) => s.setSettingsProjectId)
  // If the pick disappears, fall back to the active project, then the first.
  const selected = projects.find((p) => p.id === picked)
    ?? projects.find((p) => p.id === activeProjectId)
    ?? projects[0]
  return { projects, selected, pick }
}

/** The project dropdown over a project-scoped settings section. */
export function ProjectSelect({ projects, value, onChange, className }: {
  projects: ProjectSummary[]
  value: string
  onChange: (projectId: string) => void
  className?: string
}): JSX.Element {
  return (
    <select
      aria-label="Project"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={clsx(
        'rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-text outline-none focus:border-border-strong',
        className,
      )}
    >
      {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
  )
}
