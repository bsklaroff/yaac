import { useState, type JSX } from 'react'
import { ChatViewToggles } from '#components/ConversationView'
import { ReadOnlyTranscript } from '#components/ReadOnlyTranscript'
import { EmptyState } from '#components/ui/EmptyState'
import { agentLabel } from '#lib/agentLabel'
import { openSession } from '#lib/createWorkspace'
import { HistoryIcon, RestartIcon } from '#lib/icons'
import { pastConversations } from '#lib/panes'
import { relativeAge } from '#lib/time'
import { useReadOnly } from '#lib/viewer'
import type { WorkspaceListEntry } from '@yaac/shared/types'

const RESUME = 'flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-text px-3.5 text-xs font-medium '
  + 'text-bg hover:opacity-90 disabled:opacity-50'

/**
 * A running workspace's History pane (docs/sessions.md): the conversations
 * no agent holds (`pastConversations`), read-only as a stopped workspace's
 * are, the newest first shown. Resume opens the one shown in a new session,
 * whose pane `onResumed` is handed. A refused resume's reason shows in full
 * under the conversation it was for.
 */
export function HistoryPane({ workspace, focused, onResumed }: {
  workspace: WorkspaceListEntry
  /** The pane the user is in, which Cmd/Ctrl-F searches. */
  focused: boolean
  onResumed: (sessionId: string) => void
}): JSX.Element {
  const readOnly = useReadOnly()
  const [resuming, setResuming] = useState(false)
  const [error, setError] = useState<{ conversationId: string; message: string } | null>(null)
  const past = pastConversations(workspace)
  const resume = (conversationId: string): void => {
    setResuming(true)
    setError(null)
    openSession(workspace.workspaceId, { resume: conversationId })
      .then(onResumed)
      .catch((err: unknown) => setError({ conversationId, message: err instanceof Error ? err.message : String(err) }))
      .finally(() => setResuming(false))
  }
  if (past.length === 0) {
    return (
      <EmptyState
        className="h-full bg-bg"
        icon={HistoryIcon}
        title="No earlier conversations"
        description="A session's conversation shows here once it is closed, to read or resume."
      />
    )
  }
  return (
    <div className="@container flex h-full w-full flex-col overflow-hidden rounded-md bg-bg">
      <ReadOnlyTranscript
        workspaceId={workspace.workspaceId}
        conversations={past}
        find={{ chord: focused }}
        footer={(c) => (
          <div className="p-2">
            {c !== undefined && error?.conversationId === c.conversationId && (
              <p className="px-1 pb-2 text-xs text-danger">{error.message}</p>
            )}
            <div className="flex items-center gap-2">
              <ChatViewToggles />
              {c !== undefined && (
                <span className="min-w-0 flex-1 truncate text-xs text-text-faint">
                  {[agentLabel(c.tool, c), relativeAge(c.lastActiveAt)].filter(Boolean).join(' · ')}
                </span>
              )}
              {c !== undefined && !readOnly && (
                <button type="button" disabled={resuming} onClick={() => resume(c.conversationId)} className={RESUME}>
                  <RestartIcon size={12} />
                  {resuming ? 'Resuming…' : 'Resume'}
                </button>
              )}
            </div>
          </div>
        )}
      />
    </div>
  )
}
