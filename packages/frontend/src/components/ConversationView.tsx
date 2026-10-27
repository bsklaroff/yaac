import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type MouseEventHandler, type ReactNode,
  type RefObject,
} from 'react'
import clsx from 'clsx'
import {
  AcpTranscript, active, groupEvents, subagentCategory, taskCategory, USER_BUBBLE, type Group,
} from '#components/AcpTranscript'
import {
  ActivityTitleBar, callOf, latestActivity, StopTaskButton, SubagentPrompt, TaskView, type ActivityTarget,
} from '#components/AcpActivity'
import { useConversationFind, type FindOptions } from '#components/ConversationFind'
import type { AcpStream } from '#lib/acp'
import { dialogHoldsFocus } from '#lib/dialogFocus'
import { CondenseIcon, JumpBottomIcon, JumpTopIcon, LoadingIcon, NarrowIcon, UncondenseIcon, WidenIcon } from '#lib/icons'
import type { TranscriptPages } from '#lib/useTranscriptPages'
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

/** The pane's socket, which reads a task's output and a subagent's own
 *  transcript, and unless the view is `readOnly` answers permission asks
 *  and stops a task. */
type LiveStream = Pick<AcpStream, 'send' | 'connected' | 'history' | 'taskOutputs' | 'subagentTranscripts'>

/**
 * One conversation's view. Unless `live` (by default, while it has a
 * `stream`) it is a record: anything still marked running was cut off.
 * `readOnly` is a running conversation the viewer watches but cannot drive
 * (a teammate's): nothing answers an ask or stops a task, and an open ask
 * says it waits on `owner`. A subagent or task the events no longer hold (a
 * restarted agent) falls back to the conversation. Esc returns to it from
 * a pane on screen (`visible`).
 */
export function useConversationView({
  workspaceId,
  events,
  busy = false,
  stream,
  live = stream !== undefined,
  readOnly,
  scrollRef,
  find,
  visible = true,
}: {
  workspaceId: string
  events: AcpEvent[]
  /** A turn of the main conversation is in flight. */
  busy?: boolean
  stream?: LiveStream
  live?: boolean
  readOnly?: { owner?: string }
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
  const condensed = useUiStore((s) => s.chatCondensed)
  /** The socket that may act on the conversation. */
  const control = readOnly === undefined ? stream : undefined
  const [opened, setOpened] = useState<ActivityTarget | undefined>()
  const activity = useMemo(() => latestActivity(events), [events])
  const subagent = opened?.kind === 'subagent' ? activity.subagents.get(opened.id) : undefined
  const task = opened?.kind === 'task' ? activity.tasks.get(opened.id) : undefined
  const view = subagent !== undefined || task !== undefined ? opened : undefined

  /** A subagent the record shows without its thread is read from its own
   *  transcript: a finished one a `session/load` replay left out, or any one
   *  in a tool's history. The server sends a history's again as it grows,
   *  but only the last one the pane asked for, so it is asked for each time
   *  it is opened. */
  const ownThread = subagent !== undefined && events.some((e) => 'thread' in e && e.thread === subagent.id)
  const wantsTranscript = stream !== undefined && subagent !== undefined && !ownThread
    && (!active(subagent) || stream.history)
  const transcript = wantsTranscript ? stream.subagentTranscripts[subagent.id] : undefined
  const ask = wantsTranscript && (transcript === undefined || stream.history)
  useEffect(() => {
    if (ask && stream.connected) stream.send({ type: 'subagent-transcript', subagentId: subagent.id })
  }, [ask, stream?.connected, subagent?.id])

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
        {...(stream !== undefined && !stream.history && task.outputFile !== undefined
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
          {...(control !== undefined
            ? {
              onAnswerPermission: (requestId: string, optionId?: string) =>
                control.send({ type: 'permission', requestId, ...(optionId !== undefined ? { optionId } : {}) }),
            }
            : {})}
          {...(live && readOnly !== undefined ? { waitingOn: readOnly.owner ?? null } : {})}
          onOpenSubagent={(id) => setOpened({ kind: 'subagent', id })}
          onOpenTask={(id) => setOpened({ kind: 'task', id })}
        />
        {working && !groups.some((g) => g.kind === 'permission' && g.decided === undefined) && <Working />}
      </>
    ),
    titleBar: subagent !== undefined ? (
      <ActivityTitleBar
        category={subagentCategory(subagent)}
        title={subagent.name}
        state={subagent.state}
        live={live}
        onBack={back}
        controls={<ChatViewToggles />}
      />
    ) : task !== undefined ? (
      <ActivityTitleBar category={taskCategory(task)} title={task.name} state={task.state} live={live} onBack={back}>
        {control !== undefined && active(task) && task.canStop === true && (
          <StopTaskButton onStop={() => control.send({ type: 'stop-task', taskId: task.id })} />
        )}
      </ActivityTitleBar>
    ) : undefined,
  }
}

/** Under a running thread, in place of a TUI's spinner; not while it waits
 *  on a permission answer. A workspace still being created shows its
 *  progress as the `caption`, so the spinner carries on into the chat. */
export function Working({ caption = 'working' }: { caption?: string }): JSX.Element {
  return (
    <div className="mt-3 flex items-center gap-1.5 text-xs text-text-dim">
      <LoadingIcon size={12} className="animate-spin" />
      <span>
        {caption.replace(/(\.\.\.|…)$/, '')}
        <span className="working-dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span>
      </span>
    </div>
  )
}

/**
 * Keep a chat pane's list at its tail while the reader is there, so what
 * arrives shows as it comes, but never move a reader who scrolled up or is
 * on an earlier page. A new `view` starts at its tail. Gives the list's
 * `onScroll`; `keep`, for a layout change elsewhere (the composer growing)
 * to keep a reader at the tail there; and `pin`, to follow the tail again
 * (the reader sent a message).
 *
 * Any move up unpins at once, however small. A trackpad's first steps, or a
 * smooth scroll's first frames, stay near the tail, and a render then (one
 * per streamed event) would snap back to it and cancel the scroll. The
 * wheel and keys unpin before the scroll starts, since a render can land
 * before its first scroll event. A zoom (ctrl+wheel, a pinch) or sideways
 * (shift+wheel) wheel scrolls nothing up, and so leaves the pane pinned.
 */
export function useFollowTail(
  scrollRef: RefObject<HTMLElement | null>,
  pages: Pick<TranscriptPages, 'atEnd' | 'onScroll'>,
  view: unknown,
): { onScroll: () => void; keep: () => void; pin: () => void } {
  const pinned = useRef(true)
  const fromBottom = useRef(0)
  const atEnd = useRef(pages.atEnd)
  atEnd.current = pages.atEnd
  const keep = useCallback(() => {
    const el = scrollRef.current
    if (el && pinned.current && atEnd.current) el.scrollTop = el.scrollHeight
  }, [scrollRef])
  useLayoutEffect(() => {
    pinned.current = true
  }, [view])
  // After every render, since anything rendered may have grown the list.
  useLayoutEffect(keep)
  // And when the list shrinks, e.g. when a phone's soft keyboard opens.
  // The reader's wheel and keys are heard here too, to unpin.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(keep)
    ro.observe(el)
    const onWheel = (e: WheelEvent): void => {
      if (e.deltaY < 0 && !e.ctrlKey && !e.shiftKey && scrollsList(el, e.target)) pinned.current = false
    }
    const onKey = (e: KeyboardEvent): void => {
      if (UP_KEYS.has(e.key) && scrollsList(el, e.target)) pinned.current = false
    }
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('keydown', onKey)
    return () => {
      ro.disconnect()
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('keydown', onKey)
    }
  }, [scrollRef, keep])
  // A pixel's slack, since a zoomed page's tail can sit a fraction off. The
  // floor at 0 keeps WebKit's bounce past the tail from reading as a move up.
  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const now = Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight)
    pinned.current = now < 60 && now - fromBottom.current <= 1
    fromBottom.current = now
    pages.onScroll()
  }
  return { onScroll, keep, pin: () => { pinned.current = true } }
}

/** Keys that scroll a focused list up. */
const UP_KEYS = new Set(['ArrowUp', 'PageUp', 'Home'])

/** Whether scrolling up from `target` moves `list` itself: it is not at its
 *  top, and no box between them (a tool's output) can scroll up first. */
function scrollsList(list: HTMLElement, target: EventTarget | null): boolean {
  for (let node = target instanceof Element ? target : null; node && node !== list; node = node.parentElement) {
    if (node.scrollTop > 0 && /auto|scroll/.test(getComputedStyle(node).overflowY)) return false
  }
  return list.scrollTop > 0
}

/** In place of a page of the conversation being read, at the end it joins. */
export function PageLoading(): JSX.Element {
  return (
    <div className="my-3 flex items-center justify-center gap-1.5 text-xs text-text-faint">
      <LoadingIcon size={12} className="animate-spin" />
      Loading the conversation…
    </div>
  )
}

/** The buttons over a conversation that jump to its first message or back
 *  to its latest, shown while there is more that way than fits on screen.
 *  Its parent must be positioned. */
export function JumpButtons({ pages }: { pages: TranscriptPages }): JSX.Element | null {
  if (!pages.above && !pages.below) return null
  const button = 'pointer-events-auto flex size-8 items-center justify-center rounded-full border border-border '
    + 'bg-surface text-text-dim shadow-sm hover:bg-surface-2 hover:text-text'
  return (
    <div className="pointer-events-none absolute right-4 bottom-2 flex flex-col gap-1.5">
      {pages.above && (
        <button type="button" aria-label="Jump to the start" title="Jump to the start" onClick={pages.jumpToTop} className={button}>
          <JumpTopIcon size={15} />
        </button>
      )}
      {pages.below && (
        <button type="button" aria-label="Jump to the latest" title="Jump to the latest" onClick={pages.jumpToBottom} className={button}>
          <JumpBottomIcon size={15} />
        </button>
      )}
    </div>
  )
}

/** A create's opening prompt and its progress, drawn as the conversation it
 *  becomes: the user's message, then the spinner. */
export function Launching({ prompt, caption }: { prompt?: string; caption?: string }): JSX.Element {
  return (
    <div className="flex flex-col items-start break-words text-sm">
      {prompt !== undefined && <div className={USER_BUBBLE}>{prompt}</div>}
      <Working {...(caption !== undefined ? { caption } : {})} />
    </div>
  )
}

/** The composer's text box. index.css raises its text to 16px on phones so
 *  iOS Safari does not zoom on focus. */
export const COMPOSER_INPUT = 'block max-h-60 min-h-10 w-full resize-none bg-transparent px-3 pt-2.5 pb-1 '
  + 'text-sm text-text placeholder:text-text-faint focus:outline-none'

/** The composer's round Send and Stop buttons. */
export const ROUND_BUTTON = 'flex size-8 items-center justify-center rounded-full bg-text text-bg hover:opacity-90 '
  + 'disabled:bg-surface-3 disabled:text-text-faint'

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
