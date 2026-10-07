import type { JSX } from 'react'
import { StoppedTranscript } from '#components/StoppedTranscript'
import { PaneBarLeading, paneBarClass } from '#components/WorkspaceView'
import { EmptyState } from '#components/ui/EmptyState'
import { TerminalIcon } from '#lib/icons'
import { useIsMobile } from '#lib/viewport'
import type { WorkspaceListEntry } from '@yaac/shared/types'

/**
 * The main pane while viewing a teammate's projects: the selected live
 * workspace's conversations in the transcript view, refetched while it runs.
 * Their stopped workspaces are read in the stopped-workspaces overlay.
 * Terminals, chat and files are left out, since attaching to them grants
 * control (docs/plans/multi-user-deployment.md "Authorization").
 */
export function ReadOnlyWorkspace({ workspace }: { workspace: WorkspaceListEntry | undefined }): JSX.Element {
  const isMobile = useIsMobile()
  const title = workspace ? workspace.title || workspace.prompt || 'New workspace' : ''
  return (
    <main className="flex h-full min-w-0 flex-col">
      <header className={paneBarClass(isMobile)}>
        <PaneBarLeading />
        <span className="titlebar-drag min-w-0 flex-1 truncate font-medium text-text-dim">{title}</span>
      </header>
      {workspace ? (
        <div className="flex min-h-0 flex-1 flex-col px-3 pb-3">
          <StoppedTranscript
            key={workspace.workspaceId}
            workspaceId={workspace.workspaceId}
            sessions={workspace.agentSessions}
            {...(workspace.prompt !== undefined ? { prompt: workspace.prompt } : {})}
            live
          />
        </div>
      ) : (
        <EmptyState
          className="flex-1"
          icon={TerminalIcon}
          title="No workspace selected"
          description="Pick one of their workspaces to read its conversation."
        />
      )}
    </main>
  )
}
