import type { JSX, KeyboardEvent, PointerEvent } from 'react'
import { SidebarIcon } from '#lib/icons'
import { GitAuthFailureBadge } from '#components/GitAuthFailureBadge'
import { ImageBuildIndicator } from '#components/ImageBuildIndicator'
import { NewWorktreeButton } from '#components/NewWorktreeButton'
import { ProjectActionsMenu } from '#components/ProjectActionsMenu'
import { ServerBadge } from '#components/ServerBadge'
import { SkillsButton } from '#components/SkillsButton'
import { UsageBadge } from '#components/UsageBadge'
import { WorktreeList } from '#components/WorktreeList'
import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  useUiStore,
} from '#store'
import type {
  GitAuthFailure,
  ProvisioningWorktreeEntry,
  WorktreeGroupSummary,
  WorktreeListEntry,
} from '@yaac/shared/types'

// The list body, its groups and its row ordering live in WorktreeList — the
// mobile worktrees screen shows the same body without this card's chrome.
// Re-exported here because these are what the workspace's Alt+K/J cycle and
// the existing tests reach for.
export {
  sidebarLayout,
  sidebarRowIds,
  type SidebarGroupSection,
  type SidebarLayout,
} from '#components/WorktreeList'

/**
 * The grab strip on the sidebar's right edge. It sits in the gutter *outside*
 * the card — over the pane's padding, clear of the list's scrollbar — and
 * shows a hairline only on hover/focus so the resting layout is unchanged.
 *
 * Pointer capture is what makes the drag survive leaving the strip: every
 * move goes to the handle, so a fast drag across a terminal neither loses the
 * pointer nor lets xterm see it. The body class carries the resize cursor and
 * suppresses selection document-wide for the same reason.
 *
 * The z-10 lifts it over the pane it hangs across; the `isolate` on the card's
 * wrapper is what keeps that local (see below).
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
 * The desktop worktree list: a resizable card between the project rail and the
 * pane. Header (project actions + new worktree + hide) and status chits, over
 * the shared WorktreeList body.
 *
 * The card keeps the `overflow-hidden` that clips rows to its rounded corners,
 * so the drag handle hangs off an outer wrapper that doesn't clip.
 *
 * `isolate`: the handle's z-10 is a private arrangement between it and the
 * pane, and without a stacking context here it would outrank the whole app.
 * Base UI portals every popup to the end of <body> with no z-index of its own,
 * so the strip painted — and hit-tested — above any popup spilling into the
 * gutter. The new-worktree form does: 240px wide, anchored under a button by
 * the card's right edge, its left column landed under the strip, which lit the
 * resize hairline and swallowed the clicks. Confined, the strip still covers
 * the pane (a portal-free sibling below it in paint order) and every popup
 * clears it.
 */
export function Sidebar({
  projectSlug,
  projectRemoteUrl,
  worktrees,
  groups,
  provisioning,
  connected,
  gitAuthFailures,
}: {
  projectSlug: string | null
  /** Active project's git remote ('' until the snapshot hydrates) — the
   *  remove-project dialog's type-to-confirm text. */
  projectRemoteUrl: string
  worktrees: WorktreeListEntry[]
  /** The active project's sidebar groups. */
  groups: WorktreeGroupSummary[]
  provisioning: ProvisioningWorktreeEntry[]
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
              {projectSlug && <NewWorktreeButton projectSlug={projectSlug} />}
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
          {/* Status chits sit on their own row below the name so a long project
              name gets the full width of the header strip above. Collapses to
              nothing (empty:hidden) when no chit has anything to show. */}
          <div className="flex items-center gap-2 px-4 pb-2 empty:hidden">
            <UsageBadge />
            {/* App-scoped, not project-scoped, but it belongs with the other
                chits: the header strip above is the project's. */}
            <ServerBadge />
            <ImageBuildIndicator projectSlug={projectSlug} />
            {/* Project-wide: the stored credential is the project's, so the
                flag lives on the project header, not on individual worktrees. */}
            {gitAuthFailures.length > 0 && (
              <GitAuthFailureBadge
                failures={gitAuthFailures}
                iconSize={11}
                className="hover:bg-[#d65858]/25"
              />
            )}
          </div>
        </div>

        <WorktreeList
          projectSlug={projectSlug}
          worktrees={worktrees}
          groups={groups}
          provisioning={provisioning}
        />
      </div>

      <ResizeHandle />
    </aside>
  )
}
