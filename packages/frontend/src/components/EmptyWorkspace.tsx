import { useState, type JSX } from 'react'
import { agentLabel } from '#lib/agentLabel'
import { openSession } from '#lib/createWorkspace'
import { AddIcon, ChatIcon } from '#lib/icons'
import { relativeAge } from '#lib/time'
import { useReadOnly } from '#lib/viewer'
import type { WorkspaceListEntry } from '@yaac/shared/types'

const BUTTON = 'flex items-center justify-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs '
  + 'text-text-dim transition hover:bg-surface-2 hover:text-text disabled:opacity-50'

/**
 * A running workspace with no pane open: no session runs in it, and no
 * terminal is shown. It offers what can start here, and the conversations
 * it has held, any of which can be resumed in a new session
 * (docs/sessions.md).
 */
export function EmptyWorkspace({ workspace, onNewSession, onNewShell }: {
  workspace: WorkspaceListEntry
  onNewSession: () => void
  onNewShell: () => void
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
  return (
    <div className="flex h-full w-full overflow-y-auto bg-bg px-4 py-6">
      <div className="m-auto flex w-full max-w-md flex-col gap-4">
        <div className="text-center">
          <p className="text-sm font-medium text-text-dim">No agent is running here</p>
          <p className="mt-1 text-xs text-text-faint">
            The workspace keeps its checkout and ports until it is stopped.
          </p>
        </div>
        {!readOnly && (
          <div className="flex justify-center gap-2">
            <button type="button" onClick={onNewSession} className={BUTTON}>
              <ChatIcon size={12} />
              New session
            </button>
            <button type="button" onClick={onNewShell} className={BUTTON}>
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
