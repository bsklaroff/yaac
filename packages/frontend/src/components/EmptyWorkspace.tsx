import type { JSX } from 'react'
import { AddIcon, ChatIcon, HistoryIcon } from '#lib/icons'
import { NEW_SHELL_TITLE } from '#components/PaneBar'
import { isLocked } from '#lib/steps'
import { useReadOnly } from '#lib/viewer'
import type { WorkspaceListEntry } from '@yaac/shared/types'

const BUTTON = 'flex items-center justify-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs '
  + 'text-text-dim transition hover:bg-surface-2 hover:text-text disabled:opacity-50'

/**
 * A running workspace with no pane open: no session runs in it, and no
 * terminal is shown. It offers what can start here, including the
 * conversations it has held, read and resumed from the History pane
 * (docs/sessions.md). A non-interactive one offers nothing: it runs its
 * steps untouched (docs/workspace-steps.md), as does a public site's
 * release, which only its site manages (docs/public-sites.md).
 */
export function EmptyWorkspace({ workspace, onNewSession, onNewShell, onOpenHistory }: {
  workspace: WorkspaceListEntry
  /** Absent where nothing may start (a locked workspace). */
  onNewSession?: () => void
  onNewShell?: () => void
  /** Absent with no earlier conversation. */
  onOpenHistory?: () => void
}): JSX.Element {
  const readOnly = useReadOnly()
  if (isLocked(workspace)) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg px-4 text-center">
        <div>
          <p className="text-sm font-medium text-text-dim">
            {workspace.site !== undefined ? `This workspace serves the site “${workspace.site}”` : 'This workspace runs its steps untouched'}
          </p>
          <p className="mt-1 text-xs text-text-faint">
            {workspace.site !== undefined
              ? 'Pick a step in the bar to follow its log. Deploy, stop or start the site from Project Config → Sites.'
              : 'Pick a step in the bar to follow its log. It stops once its steps finish, and can only be stopped before.'}
          </p>
        </div>
      </div>
    )
  }
  return (
    <div className="flex h-full w-full overflow-y-auto bg-bg px-4 py-6">
      <div className="m-auto flex w-full max-w-md flex-col gap-4">
        <div className="text-center">
          <p className="text-sm font-medium text-text-dim">No agent is running here</p>
          <p className="mt-1 text-xs text-text-faint">
            The workspace keeps its checkout and ports until it is stopped.
          </p>
        </div>
        <div className="flex justify-center gap-2">
          {!readOnly && onNewSession !== undefined && onNewShell !== undefined && (
            <>
              <button type="button" onClick={onNewSession} className={BUTTON}>
                <ChatIcon size={12} />
                New session
              </button>
              <button type="button" onClick={onNewShell} title={NEW_SHELL_TITLE} className={BUTTON}>
                <AddIcon size={12} />
                New shell
              </button>
            </>
          )}
          {onOpenHistory !== undefined && (
            <button type="button" onClick={onOpenHistory} className={BUTTON}>
              <HistoryIcon size={12} />
              Earlier conversations
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
