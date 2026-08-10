import type { JSX } from 'react'
import { GitAuthFailureBadge } from '#components/GitAuthFailureBadge'
import { ImageBuildIndicator } from '#components/ImageBuildIndicator'
import { MobileHeader } from '#components/mobile/MobileHeader'
import { NewWorktreeButton } from '#components/NewWorktreeButton'
import { ProjectActionsMenu } from '#components/ProjectActionsMenu'
import { SkillsButton } from '#components/SkillsButton'
import { UsageBadge } from '#components/UsageBadge'
import { WorktreeList } from '#components/WorktreeList'
import type { GitAuthFailure, ProvisioningWorktreeEntry, WorktreeListEntry } from '@yaac/shared/types'

/**
 * The middle mobile screen: the active project's worktrees, full-bleed.
 *
 * Same body as the desktop sidebar (WorktreeList), same header affordances —
 * minus the hide-sidebar toggle, which has nothing to hide here, and plus a
 * back chevron to the project list.
 */
export function WorktreesScreen({
  projectSlug,
  projectRemoteUrl,
  worktrees,
  provisioning,
  connected,
  gitAuthFailures,
  onBack,
}: {
  projectSlug: string | null
  /** Active project's git remote ('' until the snapshot hydrates) — the
   *  remove-project dialog's type-to-confirm text. */
  projectRemoteUrl: string
  worktrees: WorktreeListEntry[]
  provisioning: ProvisioningWorktreeEntry[]
  connected: boolean
  /** The active project's rejected git credentials (project-wide flag). */
  gitAuthFailures: GitAuthFailure[]
  onBack: () => void
}): JSX.Element {
  return (
    <>
      <MobileHeader
        onBack={onBack}
        backLabel="Back to projects"
        title={projectSlug
          ? <ProjectActionsMenu slug={projectSlug} remoteUrl={projectRemoteUrl} />
          : <span>yaac</span>}
        actions={
          <>
            {!connected && <span className="pr-1 text-xs text-amber-400/80">reconnecting…</span>}
            {/* Both triggers grow to a finger-sized target below md. */}
            {projectSlug && <SkillsButton projectSlug={projectSlug} />}
            {projectSlug && <NewWorktreeButton projectSlug={projectSlug} />}
          </>
        }
      />

      {/* Status chits, collapsing to nothing when none has anything to say. */}
      <div className="flex shrink-0 items-center gap-2 px-3 py-2 empty:hidden">
        <UsageBadge />
        <ImageBuildIndicator projectSlug={projectSlug} />
        {gitAuthFailures.length > 0 && (
          <GitAuthFailureBadge
            failures={gitAuthFailures}
            iconSize={11}
            className="hover:bg-[#d65858]/25"
          />
        )}
      </div>

      <WorktreeList projectSlug={projectSlug} worktrees={worktrees} provisioning={provisioning} />
    </>
  )
}
