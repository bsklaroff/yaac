import type { JSX } from 'react'
import type { HomeRow } from '#components/home/homeRows'
import type { ProjectScope } from '#components/WorkspaceList'
import { IS_MAC } from '#lib/platform'
import { formatChord, type Chord } from '#lib/shortcuts'
import { useUiStore } from '#lib/store'
import { useReadOnly } from '#lib/viewer'
import type { ProjectSummary } from '@yaac/shared/types'
import { YCmdK, type YCmdKGroup, type YCmdKItem } from '#ui'

/*
 * The command palette's contents: sessions across projects by what they need,
 * the projects, and the app's actions. Opening a session from it keeps
 * Home open when Home is where the user is.
 */
export function CommandPalette({ scope, rows, projects }: {
  scope: ProjectScope
  rows: HomeRow[]
  projects: ProjectSummary[]
}): JSX.Element {
  const open = useUiStore((s) => s.paletteOpen)
  const setOpen = useUiStore((s) => s.setPaletteOpen)
  const homeOpen = useUiStore((s) => s.homeOpen)
  const bindings = useUiStore((s) => s.bindings)
  const readOnly = useReadOnly()
  const st = useUiStore.getState
  const projectName = (id: string): string => projects.find((p) => p.id === id)?.name ?? id
  const session = (r: HomeRow): YCmdKItem => ({
    id: `s:${r.id}`,
    title: r.title,
    text: `${r.title} ${projectName(r.projectId)}`,
    meta: projectName(r.projectId),
    ...(r.sub !== undefined ? { detail: r.sub } : {}),
    onSelect: () => (homeOpen ? st().selectHomeWorkspace(r.projectId, r.id) : st().openWorkspace(r.projectId, r.id)),
  })
  const key = (chord: Chord): string | undefined => (chord.code === '' ? undefined : formatChord(chord, IS_MAC))
  const active = scope.project
  const actions: YCmdKItem[] = [
    ...(active && !readOnly ? [{
      id: 'a:new', title: `New workspace in ${active.name}`, kbd: key(bindings['new-workspace']),
      onSelect: () => st().openNewWorkspace({ projectId: active.id }),
    }] : []),
    { id: 'a:home', title: 'Go to Home', onSelect: () => st().openHome() },
    ...(!readOnly ? [{ id: 'a:add', title: 'Add a project', onSelect: () => st().setAddProjectForm({ remoteUrl: '' }) }] : []),
    { id: 'a:settings', title: 'Open settings', onSelect: () => st().openSettings() },
    { id: 'a:keys', title: 'Keyboard shortcuts', onSelect: () => st().openSettings('shortcuts') },
  ]
  const groups: YCmdKGroup[] = [
    { label: 'Needs you', items: rows.filter((r) => r.section === 'need').map(session) },
    { label: 'Working', items: rows.filter((r) => r.section === 'working').map(session) },
    { label: 'Sessions', items: rows.filter((r) => r.section === 'done').map(session) },
    { label: 'Projects', items: projects.map((p) => ({ id: `p:${p.id}`, title: p.name, onSelect: () => st().setActiveProject(p.id) })) },
    { label: 'Actions', items: actions },
  ]
  return <YCmdK open={open} onOpenChange={setOpen} groups={groups} />
}
