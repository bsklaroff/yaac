import { useState, type JSX } from 'react'
import { BlockedHostsBadge } from '#components/BlockedHostsBadge'
import { ContainerlessBadge } from '#components/ContainerlessBadge'
import { DeadlineChip } from '#components/DeadlineChip'
import { GitAuthFailureBadge } from '#components/GitAuthFailureBadge'
import { GitStatusRows } from '#components/GitStatus'
import { StopWorkspaceDialog } from '#components/StopWorkspaceDialog'
import { shownScratchDirs, TrackedScratchDirsBadge } from '#components/TrackedScratchDirsBadge'
import { UnforwardedPortsBadge } from '#components/UnforwardedPortsBadge'
import { VolumeBadge } from '#components/VolumeBadge'
import { DockerIcon, FolderIcon, PortIcon, QueuedIcon } from '#lib/icons'
import { portLabel } from '#lib/preview'
import { stopWorkspaceOptimistic } from '#lib/stopWorkspaceFlow'
import { useSnapshotSelect } from '#lib/useSnapshot'
import type { GitAuthFailure, ProjectSummary, WorkspaceListEntry } from '@yaac/shared/types'
import { YButton, YDetailCard, YDetailRow, YDetailsPanel } from '#ui'

/** Whether a workspace has something in its Details pane that needs the
 *  user: the amber dot on the top bar's Details button. `gitFailed` is
 *  whether its git status cannot be read. */
export function detailsNeedAttention(
  workspace: WorkspaceListEntry, project: ProjectSummary | undefined, gitAuthFailures: GitAuthFailure[], gitFailed: boolean,
): boolean {
  return workspace.blockedHosts.length > 0 || workspace.unforwardedPorts.length > 0 || gitAuthFailures.length > 0
    || gitFailed || (project !== undefined && workspace.site === undefined && shownScratchDirs(workspace, project).length > 0)
}

/**
 * A workspace's Details pane: where it runs and until when, its git state,
 * its network (forwarded and unforwarded ports, blocked hosts), its
 * storage, and stopping it. What needs the user sits in a card that says
 * so while it is closed.
 */
export function DetailsPane({ workspace, project, gitAuthFailures, interactive }: {
  workspace: WorkspaceListEntry
  project: ProjectSummary | undefined
  gitAuthFailures: GitAuthFailure[]
  /** False for a teammate's or a locked workspace: no stop. */
  interactive: boolean
}): JSX.Element {
  const driver = useSnapshotSelect((s) => s?.driver)
  const [confirmStop, setConfirmStop] = useState(false)
  const network = workspace.blockedHosts.length + workspace.unforwardedPorts.length
  const [networkOpen, setNetworkOpen] = useState(network > 0)
  const scratch = project && workspace.site === undefined && shownScratchDirs(workspace, project).length > 0
  return (
    <YDetailsPanel
      className="bg-shell"
      footer={interactive && workspace.site === undefined && (
        <>
          <YButton onClick={() => setConfirmStop(true)}>Stop workspace</YButton>
          <StopWorkspaceDialog
            workspace={confirmStop ? workspace : null}
            onOpenChange={setConfirmStop}
            onConfirm={(w) => stopWorkspaceOptimistic(w, [])}
          />
        </>
      )}
    >
      <YDetailCard title="Where it runs">
        <YDetailRow icon={<DockerIcon size={13} />} note={driver === 'containerless' ? 'on this computer' : 'in the cluster'}>
          {driver === 'containerless' ? 'No container' : 'Container'}
        </YDetailRow>
        <YDetailRow icon={<FolderIcon size={13} />} note="where agents start">
          <span className="font-mono text-sm">{workspace.cwd || '/'}</span>
        </YDetailRow>
        {workspace.site === undefined && (
          <YDetailRow icon={<QueuedIcon size={13} />}>
            <DeadlineChip workspaceId={workspace.workspaceId} {...(workspace.deadline !== undefined ? { deadline: workspace.deadline } : {})} />
          </YDetailRow>
        )}
        <div className="flex flex-wrap items-center gap-1.5 empty:hidden">
          <ContainerlessBadge />
          <VolumeBadge projectId={workspace.projectId} workspaceId={workspace.workspaceId} />
        </div>
      </YDetailCard>

      <YDetailCard title="Git" summary={gitAuthFailures.length > 0 ? 'sign-in failed' : undefined} tone="danger">
        <GitStatusRows workspaceId={workspace.workspaceId} />
        {gitAuthFailures.length > 0 && (
          <GitAuthFailureBadge projectIds={[workspace.projectId]} failures={gitAuthFailures} iconSize={12} />
        )}
      </YDetailCard>

      <YDetailCard
        title="Network"
        open={networkOpen}
        onToggle={() => setNetworkOpen(!networkOpen)}
        {...(network > 0 ? { summary: networkSummary(workspace), tone: 'warning' as const } : { summary: portsSummary(workspace) })}
      >
        {workspace.forwardedPorts.map((p) => (
          <YDetailRow key={p.containerPort} icon={<PortIcon size={13} />} note="forwarded">{portLabel(p)}</YDetailRow>
        ))}
        <div className="flex flex-wrap items-center gap-1.5 empty:hidden">
          {workspace.unforwardedPorts.length > 0 && (
            <UnforwardedPortsBadge ports={workspace.unforwardedPorts} workspaceId={workspace.workspaceId} iconSize={11} />
          )}
          {workspace.blockedHosts.length > 0 && (
            <BlockedHostsBadge hosts={workspace.blockedHosts} workspaceId={workspace.workspaceId} iconSize={12} />
          )}
        </div>
        {network === 0 && workspace.forwardedPorts.length === 0 && <YDetailRow>Nothing forwarded or blocked</YDetailRow>}
      </YDetailCard>

      {scratch && (
        <YDetailCard title="Storage" summary="scratch dirs tracked in git" tone="warning">
          <TrackedScratchDirsBadge workspace={workspace} project={project} />
        </YDetailCard>
      )}
    </YDetailsPanel>
  )
}

function networkSummary(w: WorkspaceListEntry): string {
  const parts = [
    w.blockedHosts.length > 0 ? `${w.blockedHosts.length} blocked ${w.blockedHosts.length === 1 ? 'host' : 'hosts'}` : '',
    w.unforwardedPorts.length > 0 ? `${w.unforwardedPorts.length} unforwarded ${w.unforwardedPorts.length === 1 ? 'port' : 'ports'}` : '',
  ].filter(Boolean)
  return parts.join(', ')
}

function portsSummary(w: WorkspaceListEntry): string | undefined {
  const n = w.forwardedPorts.length
  return n > 0 ? `${n} ${n === 1 ? 'port' : 'ports'} forwarded` : undefined
}
