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
  ProjectSummary,
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
  projectId,
  project,
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
  projectId: string | null
  /** The active project's stopped counts, for the Stopped section. */
  project?: Pick<ProjectSummary, 'stoppedCount' | 'unseenDeaths'>
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
        title={projectId
          ? <ProjectActionsMenu projectId={projectId} remoteUrl={projectRemoteUrl} />
          : <span>yaac</span>}
        actions={
          <>
            {!connected && <span className="pr-1 text-xs text-amber-400">reconnecting…</span>}
            {projectId && <SkillsButton projectId={projectId} />}
            {projectId && <NewWorkspaceButton projectId={projectId} />}
          </>
        }
      />

      {/* Status badges; the row hides when all are empty. */}
      <div className="flex shrink-0 items-center gap-2 px-3 py-2 empty:hidden">
        <UsageBadge />
        <ImageBuildIndicator projectId={projectId} />
        {projectId && gitAuthFailures.length > 0 && (
          <GitAuthFailureBadge
            projectId={projectId}
            failures={gitAuthFailures}
            iconSize={11}
            className="hover:bg-danger/25"
          />
        )}
      </div>

      <WorkspaceList
        projectId={projectId}
        project={project}
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
