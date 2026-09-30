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
 * The middle mobile screen: the active project's workspaces. Same list and
 * header actions as the desktop sidebar, with a back button to the projects
 * screen instead of the hide-sidebar toggle.
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
  /** Active project's git remote ('' until the first snapshot); typed back
   *  to confirm removing the project. */
  projectRemoteUrl: string
  workspaces: WorkspaceListEntry[]
  groups: WorkspaceGroupSummary[]
  provisioning: ProvisioningWorkspaceEntry[]
  queued: QueuedWorkspaceEntry[]
  /** Stopped workspaces that queued entries still wait on. */
  held: HeldWorkspaceEntry[]
  drafts: DraftWorkspaceEntry[]
  connected: boolean
  /** Hosts that rejected the project's git credential. */
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
            {projectSlug && <SkillsButton projectSlug={projectSlug} />}
            {projectSlug && <NewWorkspaceButton projectSlug={projectSlug} />}
          </>
        }
      />

      {/* Status badges; the row hides when all are empty. */}
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
