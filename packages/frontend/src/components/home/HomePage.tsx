import type { JSX } from 'react'
import { api } from '#lib/api'
import { projectIconUrl } from '#lib/projectIdentity'
import { relativeAge, useNow } from '#lib/time'
import { useUiStore } from '#lib/store'
import { useReadOnly, useWhoami } from '#lib/viewer'
import type { ProjectSummary } from '@yaac/shared/types'
import { YButton, YEmptyState, YInboxItem, YListSection, YProjectCard, YTopBar } from '#ui'
import { AddIcon } from '#lib/icons'
import { PaneBarLeading } from '#components/PaneBar'
import { shortAge, unreadSessions, type HomeRow } from './homeRows'

/**
 * Home's pane: the inbox, then every project as a card. The inbox lists
 * what waits on the viewer across projects, oldest question first; a
 * finished one can be marked done (seen) from its row.
 */
export function HomePage({ rows, projects, activity, waitingByProject }: {
  rows: HomeRow[]
  projects: ProjectSummary[]
  activity: Record<string, { agents: number; failed: boolean }>
  waitingByProject: Record<string, number>
}): JSX.Element {
  const now = useNow()
  const me = useWhoami()?.userId
  const readOnly = useReadOnly()
  const select = useUiStore((s) => s.selectHomeWorkspace)
  const setActiveProject = useUiStore((s) => s.setActiveProject)
  const setAddProjectForm = useUiStore((s) => s.setAddProjectForm)
  const markWaitingSeen = useUiStore((s) => s.markWaitingSeen)
  const inbox = rows.filter((r) => r.unread)
  const projectName = (id: string): string => projects.find((p) => p.id === id)?.name ?? id

  const markDone = (r: HomeRow): void => {
    if (!r.workspace || me === undefined || r.section === 'need') return
    for (const s of unreadSessions(r.workspace, me)) {
      markWaitingSeen(s.sessionId, me)
      void api.workspace['mark-waiting-seen'].$post({
        json: { sessionId: s.sessionId, waitingSinceMs: s.waitingSinceMs ?? 0 },
      }).catch(() => {})
    }
  }

  return (
    <div className="flex h-full flex-col bg-surface">
      <YTopBar leading={<PaneBarLeading />} title="Home" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-8 py-8 max-md:px-4 max-md:py-5">
          <section aria-label="Inbox">
            <h2 className="text-lg font-semibold text-text">Inbox</h2>
            {inbox.length === 0 ? (
              <YEmptyState className="py-10" mark="logo" title="All clear" description="Nothing is waiting on you." />
            ) : (
              <div className="mt-3 flex flex-col">
                {(['need', 'done'] as const).map((section) => {
                  const items = inbox.filter((r) => (section === 'need' ? r.section === 'need' : r.section !== 'need'))
                  if (items.length === 0) return null
                  return (
                    <div key={section}>
                      <YListSection className="px-3" label={section === 'need' ? 'Needs you' : 'Finished'} count={items.length} />
                      {items.map((r) => (
                          <YInboxItem
                            key={r.id}
                            label={r.title}
                            unread
                            title={r.title}
                            project={projectName(r.projectId)}
                            {...(r.since !== undefined ? { time: shortAge(r.since, now) } : {})}
                            kind={r.section === 'need' ? (r.status === 'fail' ? 'Failed' : 'Question') : 'Done'}
                            text={r.sub ?? ''}
                            onSelect={() => select(r.projectId, r.id)}
                            actions={r.section !== 'need' && !readOnly
                              ? <YButton variant="ghost" size="sm" onClick={() => markDone(r)}>Done</YButton>
                              : undefined}
                          />
                      ))}
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          <section aria-label="Projects">
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-semibold text-text">Projects</h2>
              {!readOnly && (
                <YButton variant="ghost" size="sm" icon={AddIcon} onClick={() => setAddProjectForm({ remoteUrl: '' })}>
                  Add a project
                </YButton>
              )}
            </div>
            <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))] gap-3">
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
          </section>
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
