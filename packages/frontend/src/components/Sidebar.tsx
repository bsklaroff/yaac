import type { JSX, KeyboardEvent, PointerEvent } from 'react'
import { SidebarIcon } from '#lib/icons'
import { GitAuthFailureBadge } from '#components/GitAuthFailureBadge'
import { ImageBuildIndicator } from '#components/ImageBuildIndicator'
import { NewWorkspaceButton } from '#components/NewWorkspaceButton'
import { ProjectActionsMenu } from '#components/ProjectActionsMenu'
import { ServerBadge } from '#components/ServerBadge'
import { SkillsButton } from '#components/SkillsButton'
import { UsageBadge } from '#components/UsageBadge'
import { WorkspaceList } from '#components/WorkspaceList'
import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  useUiStore,
} from '#lib/store'
import type {
  GitAuthFailure,
  DraftWorkspaceEntry,
  HeldWorkspaceEntry,
  ProvisioningWorkspaceEntry,
  QueuedWorkspaceEntry,
  WorkspaceGroupSummary,
  WorkspaceListEntry,
} from '@yaac/shared/types'

// The list body lives in WorkspaceList, shared with the mobile screen.
// Re-exported for App's Alt+K/J row cycling and the tests.
export {
  sidebarLayout,
  sidebarRowIds,
  type SidebarGroupSection,
  type SidebarLayout,
} from '#components/WorkspaceList'

/**
 * The resize strip on the sidebar's right edge. It sits in the gutter outside
 * the card, clear of the list's scrollbar, and shows a hairline only on
 * hover/focus.
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
      className="no-drag group absolute inset-y-0 -right-2 z-10 w-2 cursor-col-resize
        touch-none outline-none"
    >
      <div className="mx-auto h-full w-px transition group-hover:bg-border-strong
        group-focus-visible:bg-accent" />
    </div>
  )
}

/**
 * The desktop workspace list: a resizable card between the project rail and
 * the pane, with a header and status chits over the shared WorkspaceList body.
 *
 * The card clips rows to its rounded corners, so the resize handle hangs off
 * an unclipped outer wrapper. That wrapper is `isolate` so the handle's z-10
 * lifts it over the pane but not over Base UI popups (portaled to <body>),
 * such as the plan-usage popover, which would otherwise lose clicks to it.
 * The fixed `#root` (index.css) confines it too; the wrapper does not rely on
 * that.
 */
export function Sidebar({
  projectSlug,
  projectRemoteUrl,
  workspaces,
  groups,
  provisioning,
  queued,
  held,
  drafts,
  connected,
  gitAuthFailures,
}: {
  projectSlug: string | null
  /** Active project's git remote ('' until the snapshot loads), typed to
   *  confirm project removal. */
  projectRemoteUrl: string
  workspaces: WorkspaceListEntry[]
  /** The active project's sidebar groups. */
  groups: WorkspaceGroupSummary[]
  provisioning: ProvisioningWorkspaceEntry[]
  /** The active project's queued workspaces, and the stopped workspaces they
   *  still wait on. */
  queued: QueuedWorkspaceEntry[]
  held: HeldWorkspaceEntry[]
  /** The active project's draft workspaces. */
  drafts: DraftWorkspaceEntry[]
  connected: boolean
  /** The active project's rejected git credentials (project-wide flag). */
  gitAuthFailures: GitAuthFailure[]
}): JSX.Element {
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)
  const sidebarWidth = useUiStore((s) => s.sidebarWidth)

  return (
    <aside
      style={{ width: sidebarWidth }}
      className="isolate relative my-2 ml-2 flex shrink-0 flex-col"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg
        border border-hairline bg-surface text-text">
        <div className="shrink-0">
          <div className="titlebar-drag flex h-11 items-center gap-2 pl-4 pr-2">
            <div className="no-drag flex min-w-0 flex-1 items-center">
              {projectSlug
                ? <ProjectActionsMenu slug={projectSlug} remoteUrl={projectRemoteUrl} />
                : <span className="font-semibold tracking-tight">yaac</span>}
            </div>
            <div className="flex shrink-0 items-center gap-2 no-drag">
              {!connected && <span className="text-xs text-amber-400/80">reconnecting…</span>}
              {projectSlug && <SkillsButton projectSlug={projectSlug} />}
              {projectSlug && <NewWorkspaceButton projectSlug={projectSlug} />}
              <button
                onClick={toggleSidebar}
                title="Hide sidebar"
                aria-label="Hide sidebar"
                className="flex h-5 w-5 items-center justify-center rounded text-text-faint transition
                  hover:bg-surface-2 hover:text-text-dim"
              >
                <SidebarIcon size={14} />
              </button>
            </div>
          </div>
          {/* Status chits get their own row so a long project name keeps the full
              header width. Hidden when empty. */}
          <div className="flex items-center gap-2 px-4 pb-2 empty:hidden">
            <UsageBadge />
            <ServerBadge />
            <ImageBuildIndicator projectSlug={projectSlug} />
            {projectSlug && gitAuthFailures.length > 0 && (
              <GitAuthFailureBadge
                projectSlug={projectSlug}
                failures={gitAuthFailures}
                iconSize={11}
                className="hover:bg-[#d65858]/25"
              />
            )}
          </div>
        </div>

        <WorkspaceList
          projectSlug={projectSlug}
          workspaces={workspaces}
          groups={groups}
          provisioning={provisioning}
          queued={queued}
          held={held}
          drafts={drafts}
        />
      </div>

      <ResizeHandle />
    </aside>
  )
}
