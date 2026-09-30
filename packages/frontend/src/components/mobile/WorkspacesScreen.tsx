import type { JSX } from 'react'
import { GitAuthFailureBadge } from '#components/GitAuthFailureBadge'
import { ImageBuildIndicator } from '#components/ImageBuildIndicator'
import { MobileHeader } from '#components/mobile/MobileHeader'
import { NewWorkspaceButton } from '#components/NewWorkspaceButton'
import { ProjectActionsMenu } from '#components/ProjectActionsMenu'
import { SkillsButton } from '#components/SkillsButton'
import { UsageBadge } from '#components/UsageBadge'
import { WorkspaceList } from '#components/WorkspaceList'
import type {
  GitAuthFailure,
  DraftWorkspaceEntry,
  HeldWorkspaceEntry,
  ProvisioningWorkspaceEntry,
  QueuedWorkspaceEntry,
  WorkspaceGroupSummary,
  WorkspaceListEntry,
} from '@yaac/shared/types'

/**
 * The middle mobile screen: the active project's workspaces, full-bleed.
 *
 * Same body as the desktop sidebar (WorkspaceList), same header affordances —
 * minus the hide-sidebar toggle, which has nothing to hide here, and plus a
 * back chevron to the project list.
 */
export function WorkspacesScreen({
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
  onBack,
}: {
  projectSlug: string | null
  /** Active project's git remote ('' until the snapshot hydrates) — the
   *  remove-project dialog's type-to-confirm text. */
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
            {projectSlug && <NewWorkspaceButton projectSlug={projectSlug} />}
          </>
        }
      />

      {/* Status chits, collapsing to nothing when none has anything to say. */}
      <div className="flex shrink-0 items-center gap-2 px-3 py-2 empty:hidden">
        <UsageBadge />
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

      <WorkspaceList
        projectSlug={projectSlug}
        workspaces={workspaces}
        groups={groups}
        provisioning={provisioning}
        queued={queued}
        held={held}
        drafts={drafts}
      />
    </>
  )
}
