import type { JSX } from 'react'
import { ChevronIcon, InboxIcon } from '#lib/icons'
import { MobileHeader } from '#components/mobile/MobileHeader'
import { NewProjectButton } from '#components/NewProjectButton'
import { listedProjects, ProjectChip, type RailTileState } from '#components/ProjectRail'
import { ServersButton } from '#components/ServerBadge'
import { ServerHealthButton } from '#components/ServerHealthOverlay'
import { FeedbackButton } from '#components/FeedbackButton'
import { SettingsButton } from '#components/SettingsButton'
import { UserSwitcher } from '#components/UserSwitcher'
import { WelcomePane } from '#components/WelcomePane'
import { projectIconUrl } from '#lib/projectIdentity'
import type { ProjectOp } from '#lib/store'
import { useTeammateView } from '#lib/viewer'
import type { ProjectSummary } from '@yaac/shared/types'
import { identityFamily, identityStyle, YButton, YEmptyState, YProjectTile } from '#ui'

/**
 * The root mobile screen: Home, then a list of named project rows (the
 * desktop rail's tiles need hover to show names), plus add-project,
 * servers (in a native shell) and settings rows.
 * A project being added or removed (`ops`) shows a spinner or a warning, as
 * on the rail; with no projects at all it shows the welcome, or for a
 * teammate's empty list a plain empty state.
 */
export function ProjectsScreen({
  projects,
  ops,
  activeProjectId,
  attentionByProject,
  tiles,
  connected,
  onHome,
  onSelect,
}: {
  projects: ProjectSummary[]
  ops: ProjectOp[]
  activeProjectId: string | null
  /** Per-project count of workspaces waiting and not yet looked at. */
  attentionByProject: Record<string, number>
  tiles: Record<string, RailTileState>
  connected: boolean
  onHome: () => void
  onSelect: (projectId: string) => void
}): JSX.Element {
  const readOnly = useTeammateView()
  const empty = projects.length === 0 && ops.length === 0
  const welcome = empty && !readOnly
  return (
    <>
      <MobileHeader
        title="yaac"
        actions={!connected
          ? <span className="pr-1 text-md text-warning">reconnecting…</span>
          : undefined}
      />

      <div className="flex-1 overflow-y-auto p-2">
        {welcome && <WelcomePane />}
        {!empty && (
          <YButton
            variant="bare"
            onClick={onHome}
            className="mb-1 flex w-full items-center gap-3 px-3 py-2.5 text-left transition active:bg-selected"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center text-muted">
              <InboxIcon size={18} />
            </span>
            <span className="min-w-0 flex-1 truncate text-base font-medium text-text">Home</span>
            {Object.values(attentionByProject).some((n) => n > 0) && <span aria-hidden className="h-1.5 w-1.5 bg-warning" />}
            <ChevronIcon size={16} className="shrink-0 text-subtle" />
          </YButton>
        )}
        {empty && readOnly && <YEmptyState compact className="py-12" title="No projects yet" />}
        {listedProjects(projects, ops).map(({ op, ...p }) => {
          const waiting = op === undefined ? attentionByProject[p.id] ?? 0 : 0
          return (
            <YButton
              variant="bare"
              key={p.id}
              onClick={() => onSelect(p.id)}
              className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition active:bg-selected"
            >
              {op !== undefined ? (
                <ProjectChip
                  project={p}
                  op={op}
                  iconSize={16}
                  className="flex h-9 w-9 shrink-0 items-center justify-center text-lg font-semibold"
                  style={identityStyle(identityFamily(p.id), false)}
                />
              ) : (
                <YProjectTile
                  id={p.id}
                  name={p.name}
                  size={36}
                  {...(p.iconHash !== undefined ? { imageUrl: projectIconUrl(p.id, p.iconHash) } : {})}
                  agents={tiles[p.id]?.agents ?? 0}
                  waiting={waiting}
                  failed={tiles[p.id]?.failed ?? false}
                  notch={false}
                />
              )}
              <span className="min-w-0 flex-1 truncate text-base font-medium text-text">{p.name}</span>
              {p.id === activeProjectId && <span className="h-1.5 w-1.5 shrink-0 bg-subtle" aria-hidden />}
              <ChevronIcon size={16} className="shrink-0 text-subtle" />
            </YButton>
          )
        })}

        <div className="mt-2 border-t border-line pt-2">
          <UserSwitcher />
          {/* The welcome has its own Add project button. */}
          {!welcome && <NewProjectButton variant="row" />}
          <FeedbackButton />
          <ServerHealthButton />
          <ServersButton />
          <SettingsButton />
        </div>
      </div>
    </>
  )
}
