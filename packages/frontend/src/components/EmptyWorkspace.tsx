import { useState, type JSX } from 'react'
import { agentLabel } from '#lib/agentLabel'
import { openSession } from '#lib/createWorkspace'
import { AddIcon, ChatIcon } from '#lib/icons'
import { NEW_SHELL_TITLE } from '#components/PaneBar'
import { isLocked } from '#lib/steps'
import { relativeAge } from '#lib/time'
import { useReadOnly } from '#lib/viewer'
import type { WorkspaceListEntry } from '@yaac/shared/types'

const BUTTON = 'flex items-center justify-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs '
  + 'text-text-dim transition hover:bg-surface-2 hover:text-text disabled:opacity-50'

/**
 * A running workspace with no pane open: no session runs in it, and no
 * terminal is shown. It offers what can start here, and the conversations
 * it has held, any of which can be resumed in a new session
 * (docs/sessions.md). A non-interactive one offers nothing: it runs its
 * steps untouched (docs/workspace-steps.md), as does a public site's
 * release, which only its site manages (docs/public-sites.md).
 */
export function EmptyWorkspace({ workspace, onNewSession, onNewShell }: {
  workspace: WorkspaceListEntry
  /** Absent where nothing may start (a locked workspace). */
  onNewSession?: () => void
  onNewShell?: () => void
}): JSX.Element {
  const readOnly = useReadOnly()
  const [error, setError] = useState<string | null>(null)
  const [resuming, setResuming] = useState<string | null>(null)
  const past = [...workspace.conversations].sort((a, b) => b.ordinal - a.ordinal)
  const resume = (conversationId: string): void => {
    setResuming(conversationId)
    setError(null)
    openSession(workspace.workspaceId, { resume: conversationId })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setResuming(null))
  }
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
        {!readOnly && onNewSession !== undefined && onNewShell !== undefined && (
          <div className="flex justify-center gap-2">
            <button type="button" onClick={onNewSession} className={BUTTON}>
              <ChatIcon size={12} />
              New session
            </button>
            <button type="button" onClick={onNewShell} title={NEW_SHELL_TITLE} className={BUTTON}>
              <AddIcon size={12} />
              New shell
            </button>
          </div>
        )}
        {past.length > 0 && (
          <div className="flex flex-col gap-1">
            <p className="px-1 text-[11px] uppercase tracking-wide text-text-faint">Earlier conversations</p>
            {past.map((c) => (
              <div key={`${c.tool}/${c.conversationId}`} className="flex items-center gap-2 rounded-md px-1 py-1 text-xs">
                <span className="min-w-0 flex-1 truncate text-text-dim" title={c.prompt}>
                  {c.prompt ?? c.conversationId}
                </span>
                <span className="shrink-0 text-text-faint">
                  {agentLabel(c.tool, c)}{c.lastActiveAt !== undefined ? ` · ${relativeAge(c.lastActiveAt)}` : ''}
                </span>
                {!readOnly && (
                  <button
                    type="button"
                    disabled={resuming !== null}
                    onClick={() => resume(c.conversationId)}
                    className={BUTTON}
                  >
                    {resuming === c.conversationId ? 'Resuming…' : 'Resume'}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {error !== null && <p className="text-center text-xs text-danger">{error}</p>}
      </div>
    </div>
  )
}
