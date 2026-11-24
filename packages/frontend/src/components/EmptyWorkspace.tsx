import type { JSX } from 'react'
import { AddIcon, ChatIcon, HistoryIcon } from '#lib/icons'
import { NEW_SHELL_TITLE, stoppedConversationsLabel } from '#components/PaneBar'
import { isLocked } from '#lib/steps'
import { useReadOnly } from '#lib/viewer'
import type { WorkspaceListEntry } from '@yaac/shared/types'
import { YButton } from '#ui'

/**
 * A running workspace with no pane open: no session runs in it, and no
 * terminal is shown. It offers what can start here, including the
 * conversations it has held, read and resumed from the History pane
 * (docs/sessions.md). A non-interactive one offers nothing: it runs its
 * steps untouched (docs/workspace-steps.md), as does a public site's
 * release, which only its site manages (docs/public-sites.md).
 */
export function EmptyWorkspace({ workspace, onNewSession, onNewShell, history }: {
  workspace: WorkspaceListEntry
  /** Absent where nothing may start (a locked workspace). */
  onNewSession?: () => void
  onNewShell?: () => void
  /** Absent with no earlier conversation. */
  history?: { count: number; onOpen: () => void }
}): JSX.Element {
  const readOnly = useReadOnly()
  if (isLocked(workspace)) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-sunken px-4 text-center">
        <div>
          <p className="text-base font-medium text-muted">
            {workspace.site !== undefined ? `This workspace serves the site “${workspace.site}”` : 'This workspace runs its steps untouched'}
          </p>
          <p className="mt-1 text-md text-subtle">
            {workspace.site !== undefined
              ? 'Pick a step in the bar to follow its log. Deploy, stop or start the site from its row under Sites in the sidebar.'
              : 'Pick a step in the bar to follow its log. It stops once its steps finish, and can only be stopped before.'}
          </p>
        </div>
      </div>
    )
  }
  return (
    <div className="flex h-full w-full overflow-y-auto bg-sunken px-4 py-6">
      <div className="m-auto flex w-full max-w-md flex-col gap-4">
        <div className="text-center">
          <p className="text-base font-medium text-muted">No agent is running here</p>
          <p className="mt-1 text-md text-subtle">
            The workspace keeps its checkout and ports until it is stopped.
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          {!readOnly && onNewSession !== undefined && onNewShell !== undefined && (
            <>
              <YButton icon={ChatIcon} onClick={onNewSession}>New agent</YButton>
              <YButton icon={AddIcon} onClick={onNewShell} title={NEW_SHELL_TITLE}>New shell</YButton>
            </>
          )}
          {history !== undefined && (
            <YButton icon={HistoryIcon} onClick={history.onOpen}>{stoppedConversationsLabel(history.count)}</YButton>
          )}
        </div>
      </div>
    </div>
  )
}
