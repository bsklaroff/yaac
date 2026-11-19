import type { JSX, KeyboardEvent, PointerEvent, ReactNode } from 'react'
import { SidebarIcon } from '#lib/icons'
import { HomeSessionList } from '#components/home/HomeSessionList'
import type { HomeRow } from '#components/home/homeRows'
import { ListBadges, ListTitle, WorkspaceList, type ProjectScope } from '#components/WorkspaceList'
import { hidesTitleBar, IS_MAC } from '#lib/platform'
import { formatChord } from '#lib/shortcuts'
import { useReadOnly } from '#lib/viewer'
import type { ProjectSummary } from '@yaac/shared/types'
import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  useUiStore,
} from '#lib/store'
import { YButton, YMenu, YMenuItem, YMenuLabel, YMenuPopup, YSidebar, YSidebarNewWorkspace, YTrafficLights } from '#ui'

// The list body lives in WorkspaceList, shared with the mobile screen.
// Re-exported for App's Alt+K/J row cycling and the tests.
export {
  sidebarLayout,
  ownedGroupIds,
  sidebarRowIds,
  type SidebarGroupSection,
  type SidebarLayout,
} from '#components/WorkspaceList'

/**
 * The resize strip on the sidebar's right edge. It sits in the gutter outside
 * the card, clear of the list's scrollbar, and shows a hairline only on
 * hover/focus.
 * The sidebar is `isolate`, so the strip's z-10 lifts it over the pane but
 * never over popups portaled to <body>.
 *
 * Pointer capture keeps a fast drag across a terminal from losing the pointer
 * or leaking events to xterm. A body class sets the resize cursor and blocks
 * text selection during the drag.
 */
function ResizeHandle(): JSX.Element {
  const width = useUiStore((s) => s.sidebarWidth)
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth)

  const startDrag = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const handle = e.currentTarget
    const startX = e.clientX
    const startWidth = width
    handle.setPointerCapture(e.pointerId)
    document.body.classList.add('col-resizing')
    const onMove = (ev: globalThis.PointerEvent): void => {
      setSidebarWidth(startWidth + (ev.clientX - startX))
    }
    const onEnd = (): void => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onEnd)
      handle.removeEventListener('pointercancel', onEnd)
      document.body.classList.remove('col-resizing')
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onEnd)
    handle.addEventListener('pointercancel', onEnd)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? 48 : 16
    if (e.key === 'ArrowLeft') setSidebarWidth(width - step)
    else if (e.key === 'ArrowRight') setSidebarWidth(width + step)
    else if (e.key === 'Home' || e.key === 'Enter') setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)
    else return
    e.preventDefault()
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={MAX_SIDEBAR_WIDTH}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={startDrag}
      onDoubleClick={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
      onKeyDown={onKeyDown}
      className="no-drag group absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize
        touch-none outline-none"
    >
      <div className="mx-auto h-full w-px transition group-hover:bg-line-strong
        group-focus-visible:bg-accent" />
    </div>
  )
}

/**
 * The sidebar, scoped by the rail. In the macOS desktop app its header
 * spans the rail as well, so the traffic lights sit in it, and the rail
 * starts under it. Elsewhere the rail starts under an empty corner of its
 * own, so its line runs beside the whole sidebar. On a project:
 * its name and actions, New workspace, then its workspaces, groups,
 * workflows, routines and sites in the order WorkspaceList keeps. On Home
 * (`home`): every project's sessions in status sections, and New workspace
 * asks which project. New workspace is highlighted while its pane shows a
 * fresh workspace form, rather than a session in a running one or a saved
 * draft, queued workspace or routine reopened for editing.
 */
export function Sidebar({ scope, connected, home, rail }: {
  scope: ProjectScope
  connected: boolean
  home?: { rows: HomeRow[]; projects: ProjectSummary[] }
  /** The project rail, which sits under the header beside the list. */
  rail: ReactNode
}): JSX.Element {
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)
  const sidebarWidth = useUiStore((s) => s.sidebarWidth)
  const openNewWorkspace = useUiStore((s) => s.openNewWorkspace)
  const bindings = useUiStore((s) => s.bindings)
  const readOnly = useReadOnly()
  const paneOpen = useUiStore((s) => !s.homeOpen && s.selectedWorkspaceId === null && s.selectedObject === null
    && s.newWorkspace?.inWorkspace === undefined && s.newWorkspace?.editId === undefined
    && s.newWorkspace?.editRoutineId === undefined && s.newWorkspace?.draftId === undefined)
  const kbd = formatChord(bindings['new-workspace'], IS_MAC) || undefined
  const projects = home?.projects ?? []
  const newWorkspace = readOnly ? undefined
    : home ? (projects.length === 1
      ? <YSidebarNewWorkspace kbd={kbd} active={paneOpen} onClick={() => openNewWorkspace({ projectId: projects[0].id })} />
      : projects.length > 1 && (
        <YMenu.Root>
          <YMenu.Trigger render={<YSidebarNewWorkspace kbd={kbd} active={paneOpen} />} />
          <YMenuPopup align="start" className="w-56">
            <YMenuLabel>New workspace in</YMenuLabel>
            {projects.map((p) => (
              <YMenuItem key={p.id} onClick={() => openNewWorkspace({ projectId: p.id })}>{p.name}</YMenuItem>
            ))}
          </YMenuPopup>
        </YMenu.Root>
      ))
    : scope.projectId && <YSidebarNewWorkspace kbd={kbd} active={paneOpen} onClick={() => openNewWorkspace({ projectId: scope.projectId ?? '' })} />

  const lights = hidesTitleBar()
  const header = (
    <div className="titlebar-drag flex h-bar shrink-0 items-center gap-2 border-b border-r border-line bg-shell pl-3 pr-1.5">
      <YTrafficLights />
      <div className="no-drag flex min-w-0 flex-1 items-center">
        {home ? <span className="text-base font-semibold tracking-tight text-text">Inbox</span> : <ListTitle scope={scope} />}
      </div>
      <div className="no-drag flex shrink-0 items-center gap-1">
        {!connected && <span className="text-sm text-warning">reconnecting…</span>}
        <YButton variant="ghost" size="sm" icon={SidebarIcon} onClick={toggleSidebar} title="Hide sidebar" aria-label="Hide sidebar" />
      </div>
    </div>
  )
  const list = (
    <YSidebar
      width={sidebarWidth}
      className="isolate"
      newWorkspace={newWorkspace || undefined}
      status={(
        <ListBadges
          projectIds={home ? home.projects.map((p) => p.id) : scope.projectId !== null ? [scope.projectId] : []}
          className="mb-1.5 border-y border-line px-4 py-1 first:border-t-0 empty:border-b-0 empty:p-0"
        />
      )}
    >
      {home ? <HomeSessionList rows={home.rows} projects={home.projects} /> : <WorkspaceList {...scope} />}
      <ResizeHandle />
    </YSidebar>
  )

  if (lights) {
    return (
      <div className="flex shrink-0 flex-col">
        {header}
        <div className="flex min-h-0 flex-1">{rail}{list}</div>
      </div>
    )
  }
  return (
    <div className="flex shrink-0">
      <div className="flex shrink-0 flex-col">
        <div aria-hidden className="h-bar shrink-0 border-b border-r border-line bg-shell" />
        <div className="flex min-h-0 flex-1">{rail}</div>
      </div>
      <div className="flex min-h-0 flex-col">
        {header}
        <div className="flex min-h-0 flex-1">{list}</div>
      </div>
    </div>
  )
}
