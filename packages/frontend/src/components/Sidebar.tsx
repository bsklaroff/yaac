import type { JSX } from 'react'
import { SidebarIcon } from '#lib/icons'
import { GitAuthFailureBadge } from '#components/GitAuthFailureBadge'
import { ImageBuildIndicator } from '#components/ImageBuildIndicator'
import { NewWorktreeButton } from '#components/NewWorktreeButton'
import { ProjectActionsMenu } from '#components/ProjectActionsMenu'
import { SkillsButton } from '#components/SkillsButton'
import { UsageBadge } from '#components/UsageBadge'
import { WorktreeList } from '#components/WorktreeList'
import { useUiStore } from '#store'
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
 * The desktop worktree list: a fixed-width card between the project rail and
 * the pane. Header (project actions + new worktree + hide) and status chits,
 * over the shared WorktreeList body.
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

  return (
    <aside className="my-2 ml-2 flex w-64 flex-col overflow-hidden rounded-lg
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
    </aside>
  )
}
