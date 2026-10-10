import { useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import clsx from 'clsx'
import { useQuery } from '@tanstack/react-query'
import { AcpTranscript, groupEvents, SUBAGENT_CATEGORY, taskCategory } from '#components/AcpTranscript'
import {
  ActivityTitleBar, callOf, latestActivity, SubagentPrompt, TaskView, type ActivityTarget,
} from '#components/AcpActivity'
import { ChatBottomBar, ChatViewToggles, useChatColumn } from '#components/WorkspaceChat'
import { useConversationFind, type FindOptions } from '#components/ConversationFind'
import { ServerError } from '@yaac/shared/errors'
import { useUiStore } from '#lib/store'
import { getSessionTranscript, TRANSCRIPT_UNAVAILABLE } from '#lib/transcriptApi'
import type { AgentSessionEntry } from '@yaac/shared/types'

/** How often a `live` transcript is refetched. */
const LIVE_REFRESH_MS = 5000

/**
 * A workspace's conversations, read-only, rendered with the same
 * `AcpTranscript` as the live chat pane and in the same column, honoring
 * its saved width and condensed toggles. A `footer` (`ReadOnlyWorkspace`'s
 * toggles and Restart) fills the bottom bar where the live pane's composer
 * sits. They
 * survive the container: an `acp` one as acpd's record, a `tui` one as the
 * tool's own history, translated server-side.
 *
 * A workspace can have several (`/clear`, or more than one agent); they show
 * as tabs in restore order. Fetched once and cached forever, since a stopped
 * conversation cannot change, unless `live`: a running workspace a teammate
 * reads this way is refetched every few seconds, under its own cache key, so
 * a poll taken before the workspace stopped is never served as its final
 * record.
 *
 * A subagent's card opens its own transcript and a task's card what the
 * record kept of it, as in the live pane, with its title bar in the
 * footer's place; both read the same query, so they refresh with it.
 *
 * Cmd/Ctrl-F searches what is shown (`useConversationFind`).
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
  const condensed = useUiStore((s) => s.chatCondensed)
  const [picked, setPicked] = useState<string | null>(null)
  // The user's pick, else the last conversation, else the first. Derived
  // rather than stored so a pick from another workspace never sticks.
  const selected = viewable.find((s) => s.agentSessionId === picked)
    ?? viewable.find((s) => s.active)
    ?? viewable[0]

  const { data, isPending, isError, error } = useQuery({
    queryKey: ['transcript', workspaceId, selected?.agentSessionId, live],
    queryFn: () => getSessionTranscript(workspaceId, selected?.agentSessionId ?? ''),
    enabled: selected !== undefined,
    staleTime: Infinity,
    refetchInterval: live ? LIVE_REFRESH_MS : false,
  })

  /** The subagent or task being read instead of the conversation, if any. */
  const [opened, setOpened] = useState<ActivityTarget | null>(null)
  const activity = Array.isArray(data) ? latestActivity(data) : undefined
  const subagent = opened?.kind === 'subagent' ? activity?.subagents.get(opened.id) : undefined
  const task = opened?.kind === 'task' ? activity?.tasks.get(opened.id) : undefined
  const groups = useMemo(
    () => (Array.isArray(data) ? groupEvents(data, subagent?.id) : []),
    [data, subagent?.id],
  )
  const taskCall = Array.isArray(data) && task?.toolCallId !== undefined
    ? callOf(data, task.toolCallId)
    : { output: '' }

  const scrollRef = useRef<HTMLDivElement>(null)
  const { bar, found } = useConversationFind({ groups: task !== undefined ? [] : groups, scrollRef, ...find })

  // Nothing readable: no conversation recorded yet (a just-stopped
  // workspace), one the server has no record of, or a history it found
  // nothing in (a checkpoint not yet exported, a tool's format changed).
  // Show the starting prompt instead.
  const empty = Array.isArray(data) && data.length === 0
  const promptOnly = selected === undefined || data === TRANSCRIPT_UNAVAILABLE || (empty && !!prompt)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {bar}
      {selected !== undefined && viewable.length > 1 && (
        <div className="flex shrink-0 flex-wrap gap-1 border-b border-hairline-soft px-3 py-1.5">
          {viewable.map((s, i) => (
            <button
              key={s.agentSessionId}
              type="button"
              onClick={() => {
                setPicked(s.agentSessionId)
                setOpened(null)
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
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
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
            {!isPending && !isError && groups.length === 0 && (
              <p className="text-xs text-text-faint">This conversation has no messages.</p>
            )}
            {task !== undefined ? (
              <TaskView
                workspaceId={workspaceId}
                task={task}
                {...(taskCall.call !== undefined ? { call: taskCall.call } : {})}
                streamed={taskCall.output}
                live={false}
              />
            ) : (
              <>
                {subagent !== undefined && <SubagentPrompt task={subagent.task} />}
                <AcpTranscript
                  workspaceId={workspaceId}
                  groups={groups}
                  found={found}
                  condensed={condensed}
                  onOpenSubagent={(id) => setOpened({ kind: 'subagent', id })}
                  onOpenTask={(id) => setOpened({ kind: 'task', id })}
                />
              </>
            )}
          </div>
        )}
      </div>
      {(subagent !== undefined || task !== undefined || footer !== undefined) && (
        <ChatBottomBar>
          {subagent !== undefined ? (
            <ActivityTitleBar
              category={SUBAGENT_CATEGORY}
              title={subagent.name}
              state={subagent.state}
              live={false}
              onBack={() => setOpened(null)}
              controls={<ChatViewToggles />}
            />
          ) : task !== undefined ? (
            <ActivityTitleBar
              category={taskCategory(task)}
              title={task.name}
              state={task.state}
              live={false}
              onBack={() => setOpened(null)}
            />
          ) : footer}
        </ChatBottomBar>
      )}
    </div>
  )
}
