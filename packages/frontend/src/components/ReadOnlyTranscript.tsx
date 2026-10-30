import { useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import clsx from 'clsx'
import { skipToken, useQuery } from '@tanstack/react-query'
import { ActivityBar } from '#components/AcpActivity'
import {
  ChatBottomBar, JumpButtons, PageLoading, useChatColumn, useConversationView, useFollowTail,
} from '#components/ConversationView'
import type { FindOptions } from '#components/ConversationFind'
import { StatusMark } from '#components/StatusMark'
import { useAcpStream } from '#lib/acp'
import { api } from '#lib/api'
import { useTranscriptPages } from '#lib/useTranscriptPages'
import { ServerError } from '@yaac/shared/errors'
import type { AcpEvent, AcpTranscriptPage } from '@yaac/shared/acp'
import type { AgentSessionEntry } from '@yaac/shared/types'

/** One empty list for every render without a transcript, so the view's
 *  memos and effects keyed on the events do not rerun each render. */
const NO_EVENTS: AcpEvent[] = []

interface ConversationProps {
  workspaceId: string
  /** The starting prompt, shown when there is no readable transcript. */
  prompt?: string
  /** The workspace is running, so its conversations are followed. */
  live?: boolean
  /** Whose answers a live conversation's asks wait on, when it is a
   *  teammate's. */
  owner?: string
  find?: FindOptions
  footer?: ReactNode
}

/**
 * A workspace's conversations, read-only, rendered with the same
 * `AcpTranscript` as the live chat pane and in the same column, honoring
 * its saved width and condensed toggles. A `footer` (`ReadOnlyWorkspace`'s
 * toggles and Restart) fills the bottom bar where the live pane's composer
 * sits. Conversations survive the container: an `acp` one as acpd's
 * record, a `tui` one as the tool's own history, translated server-side.
 *
 * A workspace can have several (`/clear`, or more than one agent); they show
 * as tabs in restore order, each with its status while the workspace runs.
 * A conversation opens at its end, on its last page, and the pages before
 * it load as the reader scrolls up or jumps to the start
 * (`useTranscriptPages`).
 *
 * A stopped conversation's last page is fetched once and cached forever,
 * since it cannot change. A `live` one (a teammate's running workspace) is
 * followed as it happens over `/acp/observe`, which the server answers for
 * an `acp` conversation as its live pane sees it and for a `tui` one as its
 * tool writes its history; only the selected conversation is followed. Its
 * last page is still fetched once, under its own cache key, to show until
 * the stream's first page arrives, so a page read while the workspace ran
 * is never served as its final record.
 *
 * A subagent's card opens its own transcript and a task's card what the
 * record kept of it, as in the live pane (`useConversationView`), with its
 * title bar in the footer's place.
 */
export function ReadOnlyTranscript({
  sessions,
  ...props
}: ConversationProps & { sessions: AgentSessionEntry[] }): JSX.Element {
  const viewable = useMemo(
    () => [...sessions].sort((a, b) => a.ordinal - b.ordinal),
    [sessions],
  )
  const [picked, setPicked] = useState<string | null>(null)
  // The user's pick, else the last conversation, else the first. Derived
  // rather than stored so a pick from another workspace never sticks.
  const selected = viewable.find((s) => s.agentSessionId === picked)
    ?? viewable.find((s) => s.active)
    ?? viewable[0]

  const tabs = selected !== undefined && viewable.length > 1 && (
    <div className="flex shrink-0 flex-wrap gap-1 border-b border-hairline-soft px-3 py-1.5">
      {viewable.map((s, i) => (
        <button
          key={s.agentSessionId}
          type="button"
          onClick={() => setPicked(s.agentSessionId)}
          title={s.prompt ?? undefined}
          className={clsx(
            'flex max-w-52 items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition max-md:py-2',
            s.agentSessionId === selected.agentSessionId
              ? 'bg-surface-3 text-text'
              : 'text-text-faint hover:bg-surface-2 hover:text-text-dim',
          )}
        >
          {props.live === true && (
            <StatusMark
              status={s.status}
              asking={s.asking === true}
              {...(props.owner !== undefined ? { owner: props.owner } : {})}
            />
          )}
          <span className="truncate">{s.prompt ?? `Conversation ${String(i + 1)}`}</span>
        </button>
      ))}
    </div>
  )

  // Keyed, so a conversation's stream, pages and open view start afresh.
  return <Conversation key={selected?.agentSessionId ?? ''} {...props} session={selected} tabs={tabs} />
}

/** One conversation of `ReadOnlyTranscript`, under its tabs. */
function Conversation({
  workspaceId,
  session,
  prompt,
  live = false,
  owner,
  find = { chord: true },
  footer,
  tabs,
}: ConversationProps & { session: AgentSessionEntry | undefined; tabs: ReactNode }): JSX.Element {
  const column = useChatColumn()
  const agentSessionId = session?.agentSessionId ?? ''
  const stream = useAcpStream(workspaceId, agentSessionId, { observe: true, enabled: live && session !== undefined })
  /** The stream has sent a page, so it is what is shown from then on, even
   *  while it reconnects. */
  const [streamed, setStreamed] = useState(false)
  if (stream.connected && !streamed) setStreamed(true)

  // `null` is a conversation the server has no record of (its 404).
  const { data, isPending, isError, error } = useQuery({
    queryKey: ['transcript', workspaceId, session?.agentSessionId, live],
    queryFn: session === undefined ? skipToken : async (): Promise<AcpTranscriptPage | null> => {
      try {
        return await api.workspace[':id']['agent-sessions'][':sessionId'].transcript.$get({
          param: { id: workspaceId, sessionId: session.agentSessionId },
          query: {},
        })
      } catch (err) {
        if (err instanceof ServerError && err.code === 'NOT_FOUND') return null
        throw err
      }
    },
    staleTime: Infinity,
  })
  const last = streamed ? stream : { life: data?.life, page: data?.page ?? 0, events: data?.events ?? NO_EVENTS }

  const scrollRef = useRef<HTMLDivElement>(null)
  const pages = useTranscriptPages({
    workspaceId,
    agentSessionId,
    life: last.life,
    last: last.page,
    lastEvents: last.events,
    scrollRef,
  })
  // A turn is in flight per the stream's turn boundaries, which arrive in
  // step with its content; else per the conversation's status, the same the
  // sidebar shows, as for a `tui` one, whose history has no turns.
  const working = live && (streamed && !stream.history
    ? stream.busy
    : session?.status === 'running' || session?.asking === true)
  const { view, open, activity, groups, findBar, body, titleBar } = useConversationView({
    workspaceId,
    events: pages.events,
    // A turn runs at the end, which an earlier page does not show.
    busy: working && pages.atEnd,
    live,
    ...(streamed ? { stream } : {}),
    readOnly: owner !== undefined ? { owner } : {},
    scrollRef,
    find,
  })
  const { onScroll, unseen } = useFollowTail(scrollRef, pages, view)

  // Nothing readable: no conversation recorded yet (a just-stopped
  // workspace), one the server has no record of, or a history it found
  // nothing in (a checkpoint not yet exported, a tool's format changed).
  // Show the starting prompt instead.
  const read = streamed ? stream : data
  const promptOnly = session === undefined || read === null
    || (read !== undefined && read.page === 0 && read.events.length === 0 && !!prompt)
  const loaded = streamed || (!isPending && !isError)
  const bottom = titleBar ?? footer

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {findBar}
      {tabs}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {promptOnly ? (
            <p className={clsx(column, 'whitespace-pre-wrap text-sm leading-relaxed text-text-dim')}>{prompt}</p>
          ) : (
            <div className={column}>
              {!streamed && isPending && <p className="text-xs text-text-faint">Loading the conversation…</p>}
              {/* Prefer the server's message, e.g. a conversation too large to send. */}
              {!streamed && isError && (
                <p className="text-xs text-text-faint">
                  {error instanceof ServerError
                    ? `This conversation could not be shown: ${error.message}.`
                    : 'The conversation could not be read.'}
                </p>
              )}
              {loaded && groups.length === 0 && pages.loading === undefined && (
                <p className="text-xs text-text-faint">This conversation has no messages.</p>
              )}
              {pages.loading === 'earlier' && <PageLoading />}
              {body}
              {pages.loading === 'later' && <PageLoading />}
            </div>
          )}
        </div>
        {!promptOnly && view === undefined && <JumpButtons pages={pages} unseen={unseen} />}
      </div>
      {bottom !== undefined && (
        <ChatBottomBar
          above={live && (
            <ActivityBar
              subagents={activity.subagents}
              tasks={activity.tasks}
              {...(view !== undefined ? { current: view } : {})}
              onOpen={open}
            />
          )}
        >
          {bottom}
        </ChatBottomBar>
      )}
    </div>
  )
}
