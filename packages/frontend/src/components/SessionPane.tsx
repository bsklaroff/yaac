import { useState, type JSX } from 'react'
import clsx from 'clsx'
import { USER_BUBBLE } from '#components/AcpTranscript'
import { ChatBottomBar, Launching, useChatColumn } from '#components/ConversationView'
import { ErrorBoundary } from '#components/ErrorBoundary'
import { StepLog } from '#components/StepLog'
import { TuiTranscriptSearch } from '#components/TuiTranscriptSearch'
import { WorkspaceChat } from '#components/WorkspaceChat'
import { WorkspaceTerminal } from '#components/WorkspaceTerminal'
import { agentLabel } from '#lib/agentLabel'
import { closeSession, resumeSession } from '#lib/createWorkspace'
import { forgetDrawnStarting, markDrawnStarting, useOpening, wasDrawnStarting, type Opening } from '#lib/opening'
import { useReadOnly } from '#lib/viewer'
import { lifeDirName } from '@yaac/shared/steps'
import {
  CONVERSATION_PROMPT_PREVIEW_LENGTH, TOOL_LABELS, type SessionEntry, type WorkspaceListEntry,
} from '@yaac/shared/types'

/** A session pane's pty target: its window, by name (`session:<name>`). */
export function sessionPtyTarget(session: Pick<SessionEntry, 'window'>): string {
  return `session:${session.window}`
}

/**
 * One session's pane (docs/sessions.md), in its mode's renderer: a chat for
 * `acp`, the agent's terminal for `tui`. An `acp` session whose agent has
 * not named a conversation yet is drawn starting, with its opening message,
 * which its chat then keeps showing until the agent echoes it, and any
 * `acp` session can switch between that chat view and its log; the chat
 * stays mounted under the log, since re-attaching is slow on a bad link.
 * One whose agent exited keeps what it showed, under a bar that resumes or
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
  const [view, setView] = useState<'chat' | 'log'>('chat')
  const conversations = workspace.conversations.filter((c) => c.sessionId === session.sessionId)
  // Only a chat session's first conversation opened with its message. One
  // that held a conversation before (a restart resuming it) is not starting.
  if (session.mode === 'acp' && session.conversationId === undefined && conversations.length === 0) {
    markDrawnStarting(session.sessionId)
  }
  const opening = useOpening(
    session.sessionId,
    session.mode === 'acp' && conversations.length <= 1 && wasDrawnStarting(session.sessionId)
      ? session.prompt : undefined,
    CONVERSATION_PROMPT_PREVIEW_LENGTH,
  )
  const showLog = (): void => setView('log')
  const onLog = view === 'log'
  const body = session.mode === 'tui' ? (
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
      <TuiTranscriptSearch
        workspaceId={workspaceId}
        paneTarget={paneTarget}
        conversations={conversations}
        visible={visible}
        focused={focused}
      />
    </div>
  ) : (
    <div className="relative h-full w-full">
      {session.conversationId !== undefined ? (
        <div className={clsx('absolute inset-0 overflow-hidden rounded-md', onLog && 'invisible')}>
          <WorkspaceChat
            key={session.conversationId}
            workspaceId={workspaceId}
            conversationId={session.conversationId}
            {...(opening !== undefined ? { opening } : {})}
            onStarted={() => forgetDrawnStarting(session.sessionId)}
            visible={visible && !onLog}
            focused={focused && !onLog}
            onShowLog={showLog}
          />
        </div>
      ) : !onLog && <AcpStarting session={session} opening={opening} onShowLog={showLog} />}
      {onLog && <AcpLog workspace={workspace} session={session} onBack={() => setView('chat')} />}
    </div>
  )
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
 * log is a click away for an agent that never comes up, and offered in the
 * pane itself for one that exited.
 */
function AcpStarting({ session, opening, onShowLog }: {
  session: SessionEntry
  opening: Opening | undefined
  onShowLog: () => void
}): JSX.Element {
  const column = useChatColumn()
  const label = TOOL_LABELS[session.tool]
  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden rounded-md bg-bg">
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className={column}>
          {session.exited === true ? (
            <div className="flex flex-col items-start break-words text-sm">
              {opening?.prompt !== undefined && <div className={USER_BUBBLE}>{opening.prompt}</div>}
              <div className="mt-3 flex items-center gap-3 text-text-dim">
                {label} exited before the chat opened.
                <button type="button" onClick={onShowLog} className={PRIMARY_BUTTON}>Show log</button>
              </div>
            </div>
          ) : <Launching {...opening} caption={`Starting ${label}…`} />}
        </div>
      </div>
      <ChatBottomBar>
        <div className="flex items-center gap-2 py-2 pl-3 pr-2">
          <span className="min-w-0 flex-1 truncate text-sm text-text-faint">
            {session.exited === true ? 'Its log may say why.' : 'The chat opens once the agent is up.'}
          </span>
          <button type="button" onClick={onShowLog} className={BAR_BUTTON}>Show log</button>
        </div>
      </ChatBottomBar>
    </div>
  )
}

/**
 * An `acp` session's log: acpd's own lines (the agent's exits and
 * restarts) and the adapter's stderr, read from the life's terminal log
 * (docs/workspace-steps.md "Logs"), under a bar that goes back to the
 * chat, or to the starting screen while the agent is not up. A chat that
 * opens while the log is shown is announced rather than switched to, so a
 * reader is never moved off what they are reading.
 */
function AcpLog({ workspace, session, onBack }: {
  workspace: WorkspaceListEntry
  session: SessionEntry
  onBack: () => void
}): JSX.Element {
  const starting = session.conversationId === undefined
  const [openedStarting] = useState(starting)
  const ready = openedStarting && !starting
  const label = TOOL_LABELS[session.tool]
  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden rounded-md bg-bg">
      <div className="min-h-0 flex-1 px-2.5 py-1.5">
        {workspace.life !== undefined && (
          <StepLog
            workspaceId={workspace.workspaceId}
            life={lifeDirName(workspace.life)}
            file={`${session.window}.log`}
            follow={session.exited !== true}
          />
        )}
      </div>
      <ChatBottomBar>
        <div className="flex items-center gap-2 py-2 pl-3 pr-2">
          <span className="min-w-0 flex-1 truncate text-sm text-text-faint">
            {ready ? 'The chat is ready.' : starting && session.exited !== true ? `Starting ${label}…` : `${label}'s log`}
          </span>
          <button type="button" onClick={onBack} className={ready ? PRIMARY_BUTTON : BAR_BUTTON}>
            {ready ? 'Open chat' : starting ? 'Back' : 'Back to chat'}
          </button>
        </div>
      </ChatBottomBar>
    </div>
  )
}

const BAR_BUTTON = 'rounded-md bg-surface-2 px-3 py-1.5 text-xs text-text-dim transition hover:bg-surface-3 '
  + 'hover:text-text disabled:opacity-50'

/** A bar button for the step the user most likely wants next. */
const PRIMARY_BUTTON = 'rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-bg transition hover:brightness-110'

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
