import { useState, type JSX } from 'react'
import { ChatBottomBar, Launching, useChatColumn } from '#components/ConversationView'
import { ErrorBoundary } from '#components/ErrorBoundary'
import { TuiTranscriptSearch } from '#components/TuiTranscriptSearch'
import { WorkspaceChat } from '#components/WorkspaceChat'
import { WorkspaceTerminal } from '#components/WorkspaceTerminal'
import { agentLabel } from '#lib/agentLabel'
import { closeSession, resumeSession } from '#lib/createWorkspace'
import { useReadOnly } from '#lib/viewer'
import { TOOL_LABELS, type SessionEntry, type WorkspaceListEntry } from '@yaac/shared/types'

/** A session pane's pty target: its window, by name (`session:<name>`). */
export function sessionPtyTarget(session: Pick<SessionEntry, 'window'>): string {
  return `session:${session.window}`
}

/**
 * One session's pane (docs/sessions.md), in its mode's renderer: a chat for
 * `acp`, the agent's terminal for `tui`. An `acp` session whose agent has
 * not named a conversation yet is drawn starting, with its opening message;
 * one whose agent exited keeps what it showed, under a bar that resumes or
 * closes it.
 */
export function SessionPane({ workspace, session, paneTarget, visible, focused, focusKey, nonce }: {
  workspace: WorkspaceListEntry
  session: SessionEntry
  /** Its pane target, which focus returns to from a transcript search. */
  paneTarget: string
  visible: boolean
  /** The pane the user is in. */
  focused: boolean
  focusKey?: number
  /** Bumped to remount a terminal that failed. */
  nonce: number
}): JSX.Element {
  const { workspaceId } = workspace
  const [showLog, setShowLog] = useState(false)
  const conversations = workspace.conversations.filter((c) => c.sessionId === session.sessionId)
  const terminal = (
    <div className="relative h-full w-full overflow-hidden rounded-md bg-bg px-2.5 py-1.5">
      {/* Its own boundary: a terminal that fails to mount (an xterm
          internal it reaches for has moved) takes down this pane, not the
          app. */}
      <ErrorBoundary key={`${session.sessionId}:${String(nonce)}`}>
        <WorkspaceTerminal
          workspaceId={workspaceId}
          target={sessionPtyTarget(session)}
          visible={visible}
          {...(focusKey !== undefined ? { focusKey } : {})}
        />
      </ErrorBoundary>
      {session.mode === 'tui' && (
        <TuiTranscriptSearch
          workspaceId={workspaceId}
          paneTarget={paneTarget}
          conversations={conversations}
          visible={visible}
          focused={focused}
        />
      )}
    </div>
  )
  const body = session.mode === 'tui' || showLog ? terminal
    : session.conversationId !== undefined ? (
      <div className="h-full w-full overflow-hidden rounded-md">
        <WorkspaceChat
          key={session.conversationId}
          workspaceId={workspaceId}
          conversationId={session.conversationId}
          // Only the session's first conversation opened with its message.
          {...(session.prompt !== undefined && conversations.length <= 1 ? { launchPrompt: session.prompt } : {})}
          visible={visible}
          focused={focused}
        />
      </div>
    )
    : <AcpStarting session={session} onShowLog={() => setShowLog(true)} />
  return (
    <div className="flex h-full w-full flex-col">
      <div className="min-h-0 flex-1">{body}</div>
      {session.exited === true && <ExitedBar workspaceId={workspaceId} session={session} />}
    </div>
  )
}

/**
 * An `acp` session before its agent has named a conversation: the message
 * it was opened with and the spinner, as the create's pane drew them. Its
 * window runs acpd, whose log is a click away for an agent that never comes
 * up.
 */
function AcpStarting({ session, onShowLog }: { session: SessionEntry; onShowLog: () => void }): JSX.Element {
  const column = useChatColumn()
  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-md bg-bg">
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className={column}>
          <Launching
            {...(session.prompt !== undefined ? { prompt: session.prompt } : {})}
            {...(session.exited === true ? {} : { caption: `Starting ${TOOL_LABELS[session.tool]}…` })}
          />
        </div>
      </div>
      <ChatBottomBar>
        <div className="flex items-center gap-2 py-2 pl-3 pr-2">
          <span className="min-w-0 flex-1 truncate text-sm text-text-faint">
            The chat opens once the agent is up.
          </span>
          <button type="button" onClick={onShowLog} className={BAR_BUTTON}>Show log</button>
        </div>
      </ChatBottomBar>
    </div>
  )
}

const BAR_BUTTON = 'rounded-md bg-surface-2 px-3 py-1.5 text-xs text-text-dim transition hover:bg-surface-3 '
  + 'hover:text-text disabled:opacity-50'

/** Under a session whose agent exited: resume it on its conversation, or
 *  close it. */
function ExitedBar({ workspaceId, session }: { workspaceId: string; session: SessionEntry }): JSX.Element {
  const readOnly = useReadOnly()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const act = (op: () => Promise<void>): void => {
    setBusy(true)
    setError(null)
    op().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }
  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-hairline bg-surface px-3 py-2 text-xs">
      <span className="min-w-0 flex-1 truncate text-text-dim">
        {error ?? `${agentLabel(session.tool, session)} exited.`}
      </span>
      {!readOnly && (
        <>
          <button type="button" disabled={busy} onClick={() => act(() => resumeSession(workspaceId, session.sessionId))}
            className={BAR_BUTTON}>
            Resume
          </button>
          <button type="button" disabled={busy} onClick={() => act(() => closeSession(workspaceId, session.sessionId))}
            className={BAR_BUTTON}>
            Close
          </button>
        </>
      )}
    </div>
  )
}
