import { useState, type JSX } from 'react'
import { ChatViewToggles } from '#components/ConversationView'
import { ReadOnlyTranscript } from '#components/ReadOnlyTranscript'
import { agentLabel } from '#lib/agentLabel'
import { openSession } from '#lib/createWorkspace'
import { HistoryIcon, RestartIcon } from '#lib/icons'
import { pastConversations } from '#lib/panes'
import { relativeAge } from '#lib/time'
import { useReadOnly } from '#lib/viewer'
import type { WorkspaceListEntry } from '@yaac/shared/types'
import { YButton, YEmptyState } from '#ui'

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
      <YEmptyState
        className="h-full bg-sunken"
        icon={HistoryIcon}
        title="No earlier conversations"
        description="An agent's conversation shows here once it is closed, to read or resume."
      />
    )
  }
  return (
    <div className="@container flex h-full w-full flex-col overflow-hidden rounded-md bg-sunken">
      <ReadOnlyTranscript
        workspaceId={workspace.workspaceId}
        conversations={past}
        find={{ chord: focused }}
        footer={(c) => (
          <div className="p-2">
            {c !== undefined && error?.conversationId === c.conversationId && (
              <p className="px-1 pb-2 text-md text-danger">{error.message}</p>
            )}
            <div className="flex items-center gap-2">
              <ChatViewToggles />
              {c !== undefined && (
                <span className="min-w-0 flex-1 truncate text-md text-subtle">
                  {[agentLabel(c.tool, c), relativeAge(c.lastActiveAt)].filter(Boolean).join(' · ')}
                </span>
              )}
              {c !== undefined && !readOnly && (
                <YButton variant="primary" icon={RestartIcon} disabled={resuming} onClick={() => resume(c.conversationId)}>
                  {resuming ? 'Resuming…' : 'Resume'}
                </YButton>

              )}
            </div>
          </div>
        )}
      />
    </div>
  )
}
