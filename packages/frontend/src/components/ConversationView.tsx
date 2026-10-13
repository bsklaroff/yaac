import { useEffect, useMemo, useState, type JSX, type MouseEventHandler, type ReactNode, type RefObject } from 'react'
import clsx from 'clsx'
import {
  AcpTranscript, active, groupEvents, SUBAGENT_CATEGORY, taskCategory, type Group,
} from '#components/AcpTranscript'
import {
  ActivityTitleBar, callOf, latestActivity, StopTaskButton, SubagentPrompt, TaskView, type ActivityTarget,
} from '#components/AcpActivity'
import { useConversationFind, type FindOptions } from '#components/ConversationFind'
import type { AcpStream } from '#lib/acp'
import { dialogHoldsFocus } from '#lib/dialogFocus'
import { CondenseIcon, LoadingIcon, NarrowIcon, UncondenseIcon, WidenIcon } from '#lib/icons'
import { useUiStore } from '#lib/store'
import type { AcpEvent } from '@yaac/shared/acp'

/**
 * What the live chat pane (`WorkspaceChat`) and the read-only one
 * (`ReadOnlyTranscript`) share: the conversation, or a subagent or
 * background task opened from it in its place, as a TUI switches to one
 * (`AcpActivity`); the find bar over whichever is shown; and the chrome
 * around them, the centered column and the bar under it.
 *
 * The hook hands back pieces rather than a laid-out pane, since the two
 * differ around them: a composer or a footer, tabs, empty states.
 */

/** The live pane's socket, which answers permission asks, reads a task's
 *  output and a finished subagent's own transcript, and stops a task. */
type LiveStream = Pick<AcpStream, 'send' | 'connected' | 'taskOutputs' | 'subagentTranscripts'>

/**
 * One conversation's view. Without `stream` it is a record: nothing can be
 * answered, and anything still marked running was cut off. A subagent or
 * task the events no longer hold (a restarted agent) falls back to the
 * conversation. Esc returns to it from a pane on screen (`visible`).
 */
export function useConversationView({
  workspaceId,
  events,
  busy = false,
  stream,
  scrollRef,
  find,
  visible = true,
}: {
  workspaceId: string
  events: AcpEvent[]
  /** A turn of the main conversation is in flight. */
  busy?: boolean
  stream?: LiveStream
  /** The scrolling element the find bar searches. */
  scrollRef: RefObject<HTMLElement | null>
  find: FindOptions
  visible?: boolean
}): {
  view: ActivityTarget | undefined
  open: (target: ActivityTarget | undefined) => void
  activity: ReturnType<typeof latestActivity>
  /** The subagent's thread while one is shown, else the conversation. */
  groups: Group[]
  findBar: JSX.Element | null
  /** What goes in the column. */
  body: JSX.Element
  /** What takes the composer's place in the bar under the column while a
   *  subagent or task is shown. */
  titleBar: JSX.Element | undefined
} {
  const live = stream !== undefined
  const condensed = useUiStore((s) => s.chatCondensed)
  const [opened, setOpened] = useState<ActivityTarget | undefined>()
  const activity = useMemo(() => latestActivity(events), [events])
  const subagent = opened?.kind === 'subagent' ? activity.subagents.get(opened.id) : undefined
  const task = opened?.kind === 'task' ? activity.tasks.get(opened.id) : undefined
  const view = subagent !== undefined || task !== undefined ? opened : undefined

  /** A finished subagent the live record shows without its thread (a
   *  `session/load` replay leaves it out) is read from its own transcript. */
  const ownThread = subagent !== undefined && events.some((e) => 'thread' in e && e.thread === subagent.id)
  const wantsTranscript = live && subagent !== undefined && !ownThread && !active(subagent)
  const transcript = wantsTranscript ? stream.subagentTranscripts[subagent.id] : undefined
  useEffect(() => {
    if (wantsTranscript && stream.connected && transcript === undefined) {
      stream.send({ type: 'subagent-transcript', subagentId: subagent.id })
    }
  }, [wantsTranscript, stream?.connected, transcript, subagent?.id])

  const groups = useMemo(() => {
    if (transcript?.events === undefined) return groupEvents(events, subagent?.id)
    const after = (events[events.length - 1]?.seq ?? -1) + 1
    return groupEvents([...events, ...transcript.events.map((e, i) => ({ ...e, seq: after + i }))], subagent?.id)
  }, [events, subagent?.id, transcript])

  const { bar: findBar, found } = useConversationFind({ groups: task !== undefined ? [] : groups, scrollRef, ...find })

  useEffect(() => {
    if (!visible || view === undefined) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !dialogHoldsFocus()) setOpened(undefined)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, view])

  /** The main thread's turn, or a subagent still running in a live pane. */
  const working = subagent === undefined ? busy : live && subagent.state === 'running'
  const call = task?.toolCallId === undefined ? { output: '' } : callOf(events, task.toolCallId)
  const back = (): void => setOpened(undefined)

  return {
    view,
    open: setOpened,
    activity,
    groups,
    findBar,
    body: task !== undefined ? (
      <TaskView
        workspaceId={workspaceId}
        task={task}
        {...(call.call !== undefined ? { call: call.call } : {})}
        streamed={call.output}
        {...(stream?.taskOutputs[task.id] !== undefined ? { output: stream.taskOutputs[task.id] } : {})}
        live={live}
        {...(live && task.outputFile !== undefined
          ? { onRefresh: () => stream.send({ type: 'task-output', taskId: task.id }) }
          : {})}
      />
    ) : (
      <>
        {subagent !== undefined && <SubagentPrompt task={subagent.task} />}
        <AcpTranscript
          workspaceId={workspaceId}
          groups={groups}
          found={found}
          busy={working}
          live={live}
          condensed={condensed}
          {...(live
            ? {
              onAnswerPermission: (requestId: string, optionId?: string) =>
                stream.send({ type: 'permission', requestId, ...(optionId !== undefined ? { optionId } : {}) }),
            }
            : {})}
          onOpenSubagent={(id) => setOpened({ kind: 'subagent', id })}
          onOpenTask={(id) => setOpened({ kind: 'task', id })}
        />
        {working && !groups.some((g) => g.kind === 'permission' && g.decided === undefined) && <Working />}
      </>
    ),
    titleBar: subagent !== undefined ? (
      <ActivityTitleBar
        category={SUBAGENT_CATEGORY}
        title={subagent.name}
        state={subagent.state}
        live={live}
        onBack={back}
        controls={<ChatViewToggles />}
      />
    ) : task !== undefined ? (
      <ActivityTitleBar category={taskCategory(task)} title={task.name} state={task.state} live={live} onBack={back}>
        {live && active(task) && task.canStop === true && (
          <StopTaskButton onStop={() => stream.send({ type: 'stop-task', taskId: task.id })} />
        )}
      </ActivityTitleBar>
    ) : undefined,
  }
}

/** Under a running thread, in place of a TUI's spinner; not while it waits
 *  on a permission answer. */
function Working(): JSX.Element {
  return (
    <div className="mt-3 flex items-center gap-1.5 text-xs text-text-dim">
      <LoadingIcon size={12} className="animate-spin" />
      <span>
        working
        <span className="working-dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span>
      </span>
    </div>
  )
}

/** The conversation and composer share one centered column, so lines stay
 *  readable in a wide pane, unless the user picks full width. The width
 *  toggle shows only in a pane wider than this cap plus the `px-4` padding
 *  (66rem), since in a narrower one both widths look the same. */
const COLUMN = 'mx-auto w-full max-w-5xl'

/** The column a chat pane's conversation sits in, per the saved width. */
export function useChatColumn(): string {
  return useUiStore((s) => s.chatFullWidth) ? 'w-full' : COLUMN
}

/**
 * The card under a chat pane's conversation, in its column: the composer,
 * or what takes its place (a subagent's or task's title bar, a stopped
 * workspace's actions). `above` stacks over the card, outside it.
 */
export function ChatBottomBar({ above, onClick, children }: {
  above?: ReactNode
  onClick?: MouseEventHandler<HTMLDivElement>
  children: ReactNode
}): JSX.Element {
  return (
    <div className="px-4 pb-3">
      <div className={useChatColumn()}>
        {above}
        <div
          onClick={onClick}
          className="rounded-xl border border-border bg-surface shadow-sm transition-colors
            focus-within:border-border-strong"
        >
          {children}
        </div>
      </div>
    </div>
  )
}

/** How each view toggle is drawn, minus its display. */
const TOGGLE = 'rounded-md p-2 text-text-faint hover:bg-surface-2 hover:text-text'

/**
 * The saved view toggles every chat pane shares, live or read-only, in the
 * bar under the conversation: full width and condensed. The width toggle
 * needs an `@container` ancestor as wide as the pane.
 */
export function ChatViewToggles(): JSX.Element {
  const fullWidth = useUiStore((s) => s.chatFullWidth)
  const setFullWidth = useUiStore((s) => s.setChatFullWidth)
  const condensed = useUiStore((s) => s.chatCondensed)
  const setCondensed = useUiStore((s) => s.setChatCondensed)
  return (
    <>
      <button
        type="button"
        aria-label={fullWidth ? 'Center chat' : 'Full-width chat'}
        title={fullWidth ? 'Center chat' : 'Full-width chat'}
        onClick={() => setFullWidth(!fullWidth)}
        className={clsx(TOGGLE, 'hidden items-center @min-[66rem]:flex')}
      >
        {fullWidth ? <NarrowIcon size={16} /> : <WidenIcon size={16} />}
      </button>
      <button
        type="button"
        aria-label={condensed ? 'Show every step' : 'Show key messages only'}
        title={condensed ? 'Show every step' : 'Show key messages only'}
        onClick={() => setCondensed(!condensed)}
        className={clsx(TOGGLE, 'flex items-center')}
      >
        {condensed ? <UncondenseIcon size={16} /> : <CondenseIcon size={16} />}
      </button>
    </>
  )
}
