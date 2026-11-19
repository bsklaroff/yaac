import type { JSX } from 'react'
import { projectIconUrl } from '#lib/projectIdentity'
import { relativeAge } from '#lib/time'
import { useUiStore } from '#lib/store'
import { useReadOnly } from '#lib/viewer'
import type { ProjectSummary } from '@yaac/shared/types'
import { YButton, YProjectCard, YTopBar } from '#ui'
import { AddIcon } from '#lib/icons'
import { PaneBarLeading } from '#components/PaneBar'
import type { HomeRow } from './homeRows'

/**
 * Home's pane: every project as a card. What waits on the viewer is the
 * Home sidebar's list (HomeSessionList), so the pane does not repeat it.
 */
export function HomePage({ rows, projects, activity, waitingByProject }: {
  rows: HomeRow[]
  projects: ProjectSummary[]
  activity: Record<string, { agents: number; failed: boolean }>
  waitingByProject: Record<string, number>
}): JSX.Element {
  const readOnly = useReadOnly()
  const setActiveProject = useUiStore((s) => s.setActiveProject)
  const setAddProjectForm = useUiStore((s) => s.setAddProjectForm)

  return (
    <div className="flex h-full flex-col bg-surface">
      <YTopBar
        leading={<PaneBarLeading />}
        title="Projects"
        trailing={!readOnly && (
          <YButton variant="ghost" size="sm" icon={AddIcon} onClick={() => setAddProjectForm({ remoteUrl: '' })}>
            Add a project
          </YButton>
        )}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-4xl grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))] gap-3 px-8 py-8 max-md:px-4 max-md:py-5">
          {projects.map((p) => {
            const working = rows.filter((r) => r.projectId === p.id && r.section === 'working').length
            const last = rows.filter((r) => r.projectId === p.id).sort((a, b) => b.order - a.order)[0]
            return (
              <YProjectCard
                key={p.id}
                id={p.id}
                name={p.name}
                remote={remoteText(p)}
                {...(p.iconHash !== undefined ? { imageUrl: projectIconUrl(p.id, p.iconHash) } : {})}
                waiting={waitingByProject[p.id] ?? 0}
                working={working}
                failed={activity[p.id]?.failed ?? false}
                rows={last ? [{
                  label: 'Latest',
                  value: last.title,
                  ...(last.since !== undefined ? { meta: relativeAge(new Date(last.since).toISOString()) } : {}),
                }] : []}
                onOpen={() => setActiveProject(p.id)}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** A project's remote, shown short: the first repo's URL without its
 *  scheme, and how many more repos it has. */
function remoteText(p: ProjectSummary): string | undefined {
  const first = p.repos[0]
  if (!first) return undefined
  const url = first.hosted ? 'hosted on this server' : first.remoteUrl.replace(/^[a-z]+:\/\/|^git@/, '').replace(/\.git$/, '')
  return p.repos.length > 1 ? `${url} and ${p.repos.length - 1} more` : url
}
