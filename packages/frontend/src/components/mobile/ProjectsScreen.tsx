import type { JSX } from 'react'
import { ChevronIcon } from '#lib/icons'
import { MobileHeader } from '#components/mobile/MobileHeader'
import { NewProjectButton } from '#components/NewProjectButton'
import { listedProjects, ProjectChip } from '#components/ProjectRail'
import { ServersButton } from '#components/ServerBadge'
import { SettingsButton } from '#components/SettingsButton'
import { UserSwitcher } from '#components/UserSwitcher'
import { EmptyState } from '#components/ui/EmptyState'
import { WelcomePane } from '#components/WelcomePane'
import { identityColor } from '#lib/projectIdentity'
import type { ProjectOp } from '#lib/store'
import { useReadOnly } from '#lib/viewer'
import type { ProjectSummary } from '@yaac/shared/types'

/**
 * The root mobile screen: a list of named project rows (the desktop rail's
 * letter chips need hover to show names), plus add-project, servers (in a
 * native shell) and settings rows.
 * A project being added or removed (`ops`) shows a spinner or a warning, as
 * on the rail; with no projects at all it shows the welcome, or for a
 * teammate's empty list a plain empty state.
 */
export function ProjectsScreen({
  projects,
  ops,
  activeProjectId,
  attentionByProject,
  connected,
  onSelect,
}: {
  projects: ProjectSummary[]
  ops: ProjectOp[]
  activeProjectId: string | null
  /** Per-project count of workspaces waiting and not yet looked at. */
  attentionByProject: Record<string, number>
  connected: boolean
  onSelect: (projectId: string) => void
}): JSX.Element {
  const readOnly = useReadOnly()
  const empty = projects.length === 0 && ops.length === 0
  const welcome = empty && !readOnly
  return (
    <>
      <MobileHeader
        title="yaac"
        actions={!connected
          ? <span className="pr-1 text-xs text-amber-400">reconnecting…</span>
          : undefined}
      />

      <div className="flex-1 overflow-y-auto p-2">
        {welcome && <WelcomePane />}
        {empty && readOnly && <EmptyState compact className="py-12" title="No projects yet" />}
        {listedProjects(projects, ops).map(({ op, ...p }) => {
          const color = identityColor(p.id)
          const waiting = op === undefined ? attentionByProject[p.id] ?? 0 : 0
          return (
            <button
              key={p.id}
              onClick={() => onSelect(p.id)}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition
                active:bg-surface-2"
            >
              <ProjectChip
                name={p.name}
                op={op}
                iconSize={16}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[15px] font-semibold"
                // Same colors as the rail chip.
                style={{
                  background: `color-mix(in oklab, ${color} 22%, var(--color-surface-2))`,
                  color: `color-mix(in oklab, ${color} 42%, var(--color-text))`,
                }}
              />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">{p.name}</span>
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
              {p.id === activeProjectId && waiting === 0 && (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-text-faint" aria-hidden />
              )}
              <ChevronIcon size={16} className="shrink-0 text-text-faint" />
            </button>
          )
        })}

        <div className="mt-2 border-t border-hairline pt-2">
          <UserSwitcher variant="row" />
          {/* The welcome has its own Add project button. */}
          {!welcome && <NewProjectButton variant="row" />}
          <ServersButton variant="row" />
          <SettingsButton variant="row" />
        </div>
      </div>
    </>
  )
}
