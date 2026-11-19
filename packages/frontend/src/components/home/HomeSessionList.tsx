import type { JSX } from 'react'
import { agentLabel } from '#lib/agentLabel'
import { sessionTarget } from '#lib/panes'
import { isSessionUnread, useUiStore } from '#lib/store'
import { useWhoami } from '#lib/viewer'
import type { ProjectSummary } from '@yaac/shared/types'
import { YEmptyState, YListSection, YSessionRow } from '#ui'
import { statusKind } from '#components/StatusMark'
import { HOME_SECTIONS, type HomeRow, type HomeSection } from './homeRows'

const LABEL: Record<HomeSection, string> = { need: 'Needs you', working: 'Working', done: 'Done' }

/**
 * The sidebar on Home: every project's sessions in status sections, each
 * naming its project. Picking one opens it and keeps Home's sidebar. A
 * workspace with several sessions lists them under its row.
 */
export function HomeSessionList({ rows, projects }: { rows: HomeRow[]; projects: ProjectSummary[] }): JSX.Element {
  const selectedId = useUiStore((s) => s.selectedWorkspaceId)
  const select = useUiStore((s) => s.selectHomeWorkspace)
  const focusTerminal = useUiStore((s) => s.focusTerminal)
  const me = useWhoami()?.userId
  const project = (id: string): { id: string; name: string } => ({ id, name: projects.find((p) => p.id === id)?.name ?? id })
  if (rows.length === 0) {
    return <YEmptyState compact className="py-12" title="Nothing running" description="Start a session in any project." />
  }
  return (
    <>
      {HOME_SECTIONS.map((section) => {
        const inSection = rows.filter((r) => r.section === section)
        if (inSection.length === 0) return null
        return (
          <div key={section} role="group" aria-label={LABEL[section]}>
            <YListSection label={LABEL[section]} />
            {inSection.map((r) => {
              const sessions = r.workspace?.sessions ?? []
              return (
                <div key={r.id}>
                  <YSessionRow
                    label={r.title}
                    status={r.status}
                    title={r.title}
                    {...(r.sub !== undefined ? { sub: r.sub } : {})}
                    project={project(r.projectId)}
                    strong={r.unread}
                    selected={r.id === selectedId}
                    onSelect={() => select(r.projectId, r.id)}
                  />
                  {sessions.length > 1 && sessions.map((s) => {
                    const name = s.title ?? s.prompt?.split('\n')[0] ?? agentLabel(s.tool, s)
                    const kind = statusKind(s.exited === true ? undefined : s.status, s.asking === true)
                    return (
                      <YSessionRow
                        key={s.sessionId}
                        label={name}
                        depth={1}
                        {...(kind !== undefined ? { status: kind } : {})}
                        title={name}
                        strong={isSessionUnread(s, me) || s.asking === true}
                        onSelect={() => {
                          select(r.projectId, r.id)
                          focusTerminal(r.id, sessionTarget(s.sessionId))
                        }}
                      />
                    )
                  })}
                </div>
              )
            })}
          </div>
        )
      })}
    </>
  )
}
