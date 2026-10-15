import { useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import clsx from 'clsx'
import { skipToken, useQuery } from '@tanstack/react-query'
import { ChatBottomBar, JumpButtons, PageLoading, useChatColumn, useConversationView } from '#components/ConversationView'
import type { FindOptions } from '#components/ConversationFind'
import { api } from '#lib/api'
import { useTranscriptPages } from '#lib/useTranscriptPages'
import { ServerError } from '@yaac/shared/errors'
import type { AcpEvent, AcpTranscriptPage } from '@yaac/shared/acp'
import type { AgentSessionEntry } from '@yaac/shared/types'

/** How often a `live` transcript is refetched. */
const LIVE_REFRESH_MS = 5000

/** One empty list for every render without a transcript, so the view's
 *  memos and effects keyed on the events do not rerun each render. */
const NO_EVENTS: AcpEvent[] = []

/**
 * A workspace's conversations, read-only, rendered with the same
 * `AcpTranscript` as the live chat pane and in the same column, honoring
 * its saved width and condensed toggles. A `footer` (`ReadOnlyWorkspace`'s
 * toggles and Restart) fills the bottom bar where the live pane's composer
 * sits. Conversations survive the container: an `acp` one as acpd's
 * record, a `tui` one as the tool's own history, translated server-side.
 *
 * A workspace can have several (`/clear`, or more than one agent); they show
 * as tabs in restore order. A conversation opens at its end, on its last
 * page, and the pages before it load as the reader scrolls up or jumps to
 * the start (`useTranscriptPages`). The last page is fetched once and cached
 * forever, since a stopped conversation cannot change, unless `live`: a
 * running workspace a teammate reads this way is refetched every few
 * seconds, under its own cache key, so a poll taken before the workspace
 * stopped is never served as its final record.
 *
 * A subagent's card opens its own transcript and a task's card what the
 * record kept of it, as in the live pane (`useConversationView`), with its
 * title bar in the footer's place; both read the same query, so they
 * refresh with it.
 */
export function ReadOnlyTranscript({
  workspaceId,
  sessions,
  prompt,
  live = false,
  find = { chord: true },
  footer,
}: {
  workspaceId: string
  sessions: AgentSessionEntry[]
  /** The starting prompt, shown when there is no readable transcript. */
  prompt?: string
  live?: boolean
  find?: FindOptions
  footer?: ReactNode
}): JSX.Element {
  const viewable = useMemo(
    () => [...sessions].sort((a, b) => a.ordinal - b.ordinal),
    [sessions],
  )
  const column = useChatColumn()
  const [picked, setPicked] = useState<string | null>(null)
  // The user's pick, else the last conversation, else the first. Derived
  // rather than stored so a pick from another workspace never sticks.
  const selected = viewable.find((s) => s.agentSessionId === picked)
    ?? viewable.find((s) => s.active)
    ?? viewable[0]

  // `null` is a conversation the server has no record of (its 404).
  const { data, isPending, isError, error } = useQuery({
    queryKey: ['transcript', workspaceId, selected?.agentSessionId, live],
    queryFn: selected === undefined ? skipToken : async (): Promise<AcpTranscriptPage | null> => {
      try {
        return await api.workspace[':id']['agent-sessions'][':sessionId'].transcript.$get({
          param: { id: workspaceId, sessionId: selected.agentSessionId },
          query: {},
        })
      } catch (err) {
        if (err instanceof ServerError && err.code === 'NOT_FOUND') return null
        throw err
      }
    },
    staleTime: Infinity,
    refetchInterval: live ? LIVE_REFRESH_MS : false,
  })

  const scrollRef = useRef<HTMLDivElement>(null)
  const pages = useTranscriptPages({
    workspaceId,
    agentSessionId: selected?.agentSessionId ?? '',
    life: data?.life,
    last: data?.page ?? 0,
    lastEvents: data?.events ?? NO_EVENTS,
    scrollRef,
  })
  const { view, open, groups, findBar, body, titleBar } = useConversationView({
    workspaceId, events: pages.events, scrollRef, find,
  })

  // Nothing readable: no conversation recorded yet (a just-stopped
  // workspace), one the server has no record of, or a history it found
  // nothing in (a checkpoint not yet exported, a tool's format changed).
  // Show the starting prompt instead.
  const promptOnly = selected === undefined || data === null || (data?.page === 0 && data.events.length === 0 && !!prompt)
  const bottom = titleBar ?? footer

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {findBar}
      {selected !== undefined && viewable.length > 1 && (
        <div className="flex shrink-0 flex-wrap gap-1 border-b border-hairline-soft px-3 py-1.5">
          {viewable.map((s, i) => (
            <button
              key={s.agentSessionId}
              type="button"
              onClick={() => {
                setPicked(s.agentSessionId)
                open(undefined)
              }}
              title={s.prompt ?? undefined}
              className={clsx(
                'max-w-52 truncate rounded-md px-2 py-1 text-[11px] transition max-md:py-2',
                s.agentSessionId === selected.agentSessionId
                  ? 'bg-surface-3 text-text'
                  : 'text-text-faint hover:bg-surface-2 hover:text-text-dim',
              )}
            >
              {s.prompt ?? `Conversation ${String(i + 1)}`}
            </button>
          ))}
        </div>
      )}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={scrollRef} onScroll={pages.onScroll} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {promptOnly ? (
            <p className={clsx(column, 'whitespace-pre-wrap text-sm leading-relaxed text-text-dim')}>{prompt}</p>
          ) : (
            <div className={column}>
              {isPending && <p className="text-xs text-text-faint">Loading the conversation…</p>}
              {/* Prefer the server's message, e.g. a conversation too large to send. */}
              {isError && (
                <p className="text-xs text-text-faint">
                  {error instanceof ServerError
                    ? `This conversation could not be shown: ${error.message}.`
                    : 'The conversation could not be read.'}
                </p>
              )}
              {!isPending && !isError && groups.length === 0 && pages.loading === undefined && (
                <p className="text-xs text-text-faint">This conversation has no messages.</p>
              )}
              {pages.loading === 'earlier' && <PageLoading />}
              {body}
              {pages.loading === 'later' && <PageLoading />}
            </div>
          )}
        </div>
        {!promptOnly && view === undefined && <JumpButtons pages={pages} />}
      </div>
      {bottom !== undefined && <ChatBottomBar>{bottom}</ChatBottomBar>}
    </div>
  )
}
