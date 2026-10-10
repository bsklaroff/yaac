import {
  useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type MouseEventHandler, type ReactNode,
} from 'react'
import clsx from 'clsx'
import { useAcpStream } from '#lib/acp'
import {
  AcpTranscript, active, groupEvents, SUBAGENT_CATEGORY, taskCategory, type Group,
} from '#components/AcpTranscript'
import {
  ActivityBar, ActivityTitleBar, callOf, latestActivity, StopTaskButton, SubagentPrompt, TaskView, type ActivityTarget,
} from '#components/AcpActivity'
import { useComposerMenu } from '#components/ComposerMenu'
import { useConversationFind } from '#components/ConversationFind'
import { EffortMenu } from '#components/EffortMenu'
import { PermissionModeMenu } from '#components/PermissionModeMenu'
import { imageBytes, imageFiles, prepareImage, toAcpImage, useImageSrc } from '#lib/attachments'
import { dialogHoldsFocus } from '#lib/dialogFocus'
import {
  AttachImageIcon, CloseIcon, CondenseIcon, LoadingIcon, NarrowIcon, SendIcon, StopIcon, UncondenseIcon, WidenIcon,
} from '#lib/icons'
import { chatDraftKey, useUiStore } from '#lib/store'
import { MAX_ATTACHMENT_BYTES } from '@yaac/shared/attachments'
import type { AcpContent, AcpEvent, AcpImage, AcpQueuedPrompt } from '@yaac/shared/acp'

/**
 * The chat pane for an `acp` conversation; `WorkspaceTerminal` fills the
 * same slot for `tui`. Like the terminal, it stays mounted with its socket
 * open while off-screen, because re-attaching is slow on a bad link;
 * `visible` only decides focus. The draft lives in the ui store so it
 * survives the pane unmounting or a reload.
 *
 * Rendering is `AcpTranscript`'s job (shared with stopped workspaces). This
 * component owns the stream, the draft, the composer and scroll-follow; the
 * composer's completion menu is `useComposerMenu`'s.
 *
 * Like a TUI, the pane can switch from the conversation to one of the
 * subagents or background tasks the agent started (`AcpActivity`), and Esc
 * or Back returns. Those views put their title bar in the composer's place,
 * since the agent takes messages only on its main thread.
 *
 * Cmd/Ctrl-F searches whichever view is shown (`useConversationFind`).
 */

/** The text parts of a `user` event, for comparing against a draft. */
function promptText(content: AcpContent[]): string {
  return content.filter((c) => c.type === 'text').map((c) => c.text).join('')
}

/** Identifies a sent message's echo by its text and image count, since a
 *  message may be images alone. */
function echoKey(text: string, images: number): string {
  return `${text}\u0000${String(images)}`
}

export function WorkspaceChat({
  workspaceId,
  agentSessionId,
  visible = true,
  focused = visible,
}: {
  workspaceId: string
  agentSessionId: string
  visible?: boolean
  /** The pane the user is in, which Cmd/Ctrl-F searches. */
  focused?: boolean
}): JSX.Element {
  const { events, busy, queued, connected, send, taskOutputs, subagentTranscripts, permissionModes, efforts } = useAcpStream(workspaceId, agentSessionId)
  const setChatDraft = useUiStore((s) => s.setChatDraft)
  const setChatSent = useUiStore((s) => s.setChatSent)
  const condensed = useUiStore((s) => s.chatCondensed)
  const column = useChatColumn()
  /**
   * The draft is local state mirrored into the store, so typing needs no
   * store round trip. The pane is keyed by conversation, so seeding once on
   * mount is enough.
   */
  const [draft, setDraft] = useState(
    () => useUiStore.getState().chatDrafts[chatDraftKey(workspaceId, agentSessionId)]?.text ?? '',
  )
  /**
   * A message sent on the socket but not yet echoed back as a `user` event.
   * The text stays in the box until the echo arrives, so a dropped connection
   * leaves it there to send again.
   */
  const [awaitingEcho, setAwaitingEcho] = useState<string | null>(null)
  /**
   * Images attached to the draft (docs/agent-modes.md, "Images"). Too large
   * to persist in the store, so a reload drops them.
   */
  const [images, setImages] = useState<AcpImage[]>([])
  /** The attached images as of this render, for an attach finishing later. */
  const imagesRef = useRef(images)
  imagesRef.current = images
  const [imageError, setImageError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  /** The draft and in-flight message this pane mounted with, and whether
   *  they have been checked against the replayed history yet. */
  const restoredRef = useRef(draft)
  const restoredSentRef = useRef(
    useUiStore.getState().chatDrafts[chatDraftKey(workspaceId, agentSessionId)]?.sent,
  )
  const reconciledRef = useRef(false)
  const groups = useMemo(() => groupEvents(events), [events])
  /** The subagent or task being viewed instead of the conversation. One
   *  the stream no longer has (a restarted agent) falls back to it. */
  const [opened, setOpened] = useState<ActivityTarget | undefined>()
  const activity = useMemo(() => latestActivity(events), [events])
  const usage = useMemo(() => contextUsage(events), [events])
  const subagent = opened?.kind === 'subagent' ? activity.subagents.get(opened.id) : undefined
  const task = opened?.kind === 'task' ? activity.tasks.get(opened.id) : undefined
  const view = subagent !== undefined || task !== undefined ? opened : undefined
  /** A finished subagent the record shows without its thread (a
   *  `session/load` replay leaves it out) is read from its own transcript. */
  const ownThread = subagent !== undefined && events.some((e) => 'thread' in e && e.thread === subagent.id)
  const wantsTranscript = subagent !== undefined && !ownThread && !active(subagent)
  const transcript = wantsTranscript ? subagentTranscripts[subagent.id] : undefined
  useEffect(() => {
    if (wantsTranscript && connected && transcript === undefined) send({ type: 'subagent-transcript', subagentId: subagent.id })
  }, [wantsTranscript, connected, transcript, subagent?.id])
  const threadGroups = useMemo(() => {
    if (subagent === undefined) return []
    const after = (events[events.length - 1]?.seq ?? -1) + 1
    const read = (transcript?.events ?? []).map((e, i) => ({ ...e, seq: after + i }))
    return groupEvents([...events, ...read], subagent.id)
  }, [events, subagent?.id, transcript])
  /** The call that started the task, and what it streamed. */
  const taskCall = useMemo(
    () => (task?.toolCallId === undefined ? { output: '' } : callOf(events, task.toolCallId)),
    [events, task?.toolCallId],
  )
  const taskOutput = task === undefined ? undefined : taskOutputs[task.id]
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const { bar: findBar, found } = useConversationFind({
    groups: subagent !== undefined ? threadGroups : task !== undefined ? [] : groups,
    scrollRef,
    chord: focused,
    onClose: () => inputRef.current?.focus(),
  })

  // Follow the tail only while the reader is already at it, so streaming
  // never yanks someone who scrolled up.
  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  }
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [groups, threadGroups, view, taskOutput, condensed])

  /** Show a subagent or task, or the conversation again; each starts at
   *  its tail. */
  const open = (target: ActivityTarget | undefined): void => {
    pinnedRef.current = true
    setOpened(target)
  }

  useEffect(() => {
    if (!visible || view === undefined) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || dialogHoldsFocus()) return
      pinnedRef.current = true
      setOpened(undefined)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, view])

  // Grow the textarea to fit the draft, up to its CSS max-height. Reset to
  // `auto` first so scrollHeight measures the content. Growing shrinks the
  // conversation, so keep a reader at the tail pinned there.
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
    const list = scrollRef.current
    if (list && pinnedRef.current) list.scrollTop = list.scrollHeight
  }, [draft])

  // Keep a pinned reader at the tail when the list shrinks, e.g. when a
  // phone's soft keyboard opens.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (pinnedRef.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!visible || dialogHoldsFocus()) return
    inputRef.current?.focus()
  }, [visible, view])

  useEffect(() => {
    setChatDraft(workspaceId, agentSessionId, draft)
  }, [draft, workspaceId, agentSessionId, setChatDraft])

  /**
   * On first connect, settle a message a previous mount sent but never saw
   * echoed. Clear the box only if it still holds that exact message (the
   * `sent` marker, so a freshly typed identical text is kept) and either the
   * replayed history's last user message matches it or the server holds it
   * queued. The marker is dropped either way.
   */
  useEffect(() => {
    if (reconciledRef.current || !connected) return
    reconciledRef.current = true
    const sent = restoredSentRef.current
    if (sent === undefined) return
    setChatSent(workspaceId, agentSessionId, undefined)
    if (restoredRef.current.trim() !== sent) return
    let lastUser: string | undefined
    for (const e of events) if (e.type === 'user' && e.thread === undefined) lastUser = promptText(e.content)
    if (lastUser !== sent && !queued.some((q) => q.text === sent)) return
    // Keep anything typed while connecting.
    setDraft((cur) => (cur === restoredRef.current ? '' : cur))
  }, [connected, events, queued, workspaceId, agentSessionId, setChatSent])

  // The server's `user` echo confirms a send and clears the box, as does the
  // message showing up in the queue.
  useEffect(() => {
    if (awaitingEcho === null) return
    const echoed = events.some((e) => e.type === 'user' && e.thread === undefined
      && echoKey(promptText(e.content), e.content.filter((c) => c.type === 'image').length) === awaitingEcho)
      || queued.some((q) => echoKey(q.text, q.images) === awaitingEcho)
    if (echoed) {
      setDraft('')
      setImages([])
      setAwaitingEcho(null)
      setChatSent(workspaceId, agentSessionId, undefined)
    }
  }, [events, queued, awaitingEcho, workspaceId, agentSessionId, setChatSent])

  // A drop before the echo means the message may not have arrived; unlock
  // the box with the text still in it.
  useEffect(() => {
    if (!connected) setAwaitingEcho(null)
  }, [connected])

  // So does an error: a conversation whose record failed stays connected but
  // never echoes, which would lock the box forever.
  useEffect(() => {
    if (events.length > 0 && events[events.length - 1].type === 'error') setAwaitingEcho(null)
  }, [events])

  /**
   * Send the draft, or `override` in its place (a command picked from the
   * menu), which then stays in the box until its echo. Allowed mid-turn, as
   * in a TUI: the server adds the message to the turn or queues it.
   */
  const submit = (override?: string): void => {
    const text = (override ?? draft).trim()
    if ((text === '' && images.length === 0) || !connected || awaitingEcho !== null) return
    if (send({ type: 'prompt', text, ...(images.length > 0 ? { images } : {}) })) {
      if (override !== undefined) setDraft(text)
      setAwaitingEcho(echoKey(text, images.length))
      // Stored so a remount before the echo knows this text was in flight.
      setChatSent(workspaceId, agentSessionId, text)
      pinnedRef.current = true
    }
  }

  /** Attach pasted, dropped or picked images to the draft, shrunk to what the
   *  model reads. */
  const attach = (files: File[]): void => {
    setImageError(null)
    void Promise.all(files.map(async (f) => toAcpImage(await prepareImage(f))))
      .then((added) => {
        // The server enforces the same limit; check it before sending.
        const next = [...imagesRef.current, ...added]
        if (next.reduce((n, image) => n + imageBytes(image), 0) > MAX_ATTACHMENT_BYTES) {
          setImageError('a message\'s images may total 5 MB')
          return
        }
        // Update now so a concurrent attach builds on this one.
        imagesRef.current = next
        setImages(next)
      })
      .catch((err: unknown) => setImageError(err instanceof Error ? err.message : String(err)))
  }

  const { menu, inputProps: menuInputProps, onKeyDown: menuKeyDown } = useComposerMenu({
    inputRef,
    draft,
    events,
    disabled: awaitingEcho !== null,
    setDraft,
    runCommand: submit,
    switchModel: (modelId) => send({ type: 'model', modelId }),
  })

  /** Answer a permission ask. Returns whether it was sent, so the card can
   *  re-offer its buttons if the socket was down. */
  const answerPermission = (requestId: string, optionId?: string): boolean =>
    send({ type: 'permission', requestId, ...(optionId !== undefined ? { optionId } : {}) })

  return (
    <div
      className="@container flex h-full w-full flex-col bg-bg"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault()
      }}
      onDrop={(e) => {
        const files = imageFiles(e.dataTransfer)
        if (files.length === 0 || awaitingEcho !== null) return
        e.preventDefault()
        attach(files)
      }}
    >
      {findBar}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto px-4 py-4"
      >
        {view === undefined && groups.length === 0 && (
          <div className="flex h-full items-center justify-center text-xs text-text-faint">
            {connected ? 'No messages yet — say something.' : 'Connecting to the agent…'}
          </div>
        )}
        <div className={column}>
          {subagent !== undefined ? (
            <>
              <SubagentPrompt task={subagent.task} />
              <AcpTranscript
                workspaceId={workspaceId}
                groups={threadGroups}
                found={found}
                busy={subagent.state === 'running'}
                live
                condensed={condensed}
                onAnswerPermission={answerPermission}
                onOpenSubagent={(id) => open({ kind: 'subagent', id })}
              />
              {subagent.state === 'running' && !awaitingPermission(threadGroups) && <Working />}
            </>
          ) : task !== undefined ? (
            <TaskView
              workspaceId={workspaceId}
              task={task}
              {...(taskCall.call !== undefined ? { call: taskCall.call } : {})}
              streamed={taskCall.output}
              {...(taskOutput !== undefined ? { output: taskOutput } : {})}
              live
              {...(task.outputFile !== undefined
                ? { onRefresh: () => send({ type: 'task-output', taskId: task.id }) }
                : {})}
            />
          ) : (
            <>
              <AcpTranscript
                workspaceId={workspaceId}
                groups={groups}
                found={found}
                busy={busy}
                live
                condensed={condensed}
                onAnswerPermission={answerPermission}
                onOpenSubagent={(id) => open({ kind: 'subagent', id })}
                onOpenTask={(id) => open({ kind: 'task', id })}
              />
              {busy && !awaitingPermission(groups) && <Working />}
              {queued.map((q) => (
                <QueuedMessage key={q.id} prompt={q} onRemove={() => send({ type: 'unqueue', id: q.id })} />
              ))}
            </>
          )}
        </div>
      </div>

      <ChatBottomBar
        above={
          <>
            {!connected && (
              <div className="mb-1.5 px-1 text-xs text-text-faint">
                Disconnected — the agent keeps working; this pane reattaches automatically.
              </div>
            )}
            <ActivityBar
              subagents={activity.subagents}
              tasks={activity.tasks}
              {...(view !== undefined ? { current: view } : {})}
              onOpen={open}
            />
            {view === undefined && imageError !== null && (
              <div className="mb-1.5 px-1 text-xs text-error">Image not attached: {imageError}</div>
            )}
            {view === undefined && menu}
          </>
        }
        onClick={(e) => {
          if (e.target === e.currentTarget) inputRef.current?.focus()
        }}
      >
        {subagent !== undefined ? (
          <ActivityTitleBar
            category={SUBAGENT_CATEGORY}
            title={subagent.name}
            state={subagent.state}
            live
            onBack={() => open(undefined)}
            controls={<ChatViewToggles />}
          />
        ) : task !== undefined ? (
          <ActivityTitleBar
            category={taskCategory(task)}
            title={task.name}
            state={task.state}
            live
            onBack={() => open(undefined)}
          >
            {active(task) && task.canStop === true && (
              <StopTaskButton onStop={() => send({ type: 'stop-task', taskId: task.id })} />
            )}
          </ActivityTitleBar>
        ) : (
          <>
            {images.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-3 pt-3">
                {images.map((image, i) => (
                  <DraftImage
                    key={i}
                    image={image}
                    workspaceId={workspaceId}
                    {...(awaitingEcho === null
                      ? { onRemove: () => setImages((cur) => cur.filter((_, j) => j !== i)) }
                      : {})}
                  />
                ))}
              </div>
            )}
            <textarea
              ref={inputRef}
              {...menuInputProps}
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onPaste={(e) => {
                const files = imageFiles(e.clipboardData)
                if (files.length === 0 || awaitingEcho !== null) return
                e.preventDefault()
                attach(files)
              }}
              onKeyDown={(e) => {
                if (menuKeyDown(e)) return
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submit()
                }
              }}
              placeholder={connected ? 'Message the agent…' : 'Reconnecting…'}
              readOnly={awaitingEcho !== null}
              // index.css raises this to 16px on phones so iOS Safari does not
              // zoom on focus.
              className="block max-h-60 min-h-10 w-full resize-none bg-transparent px-3 pt-2.5 pb-1
                text-sm text-text placeholder:text-text-faint focus:outline-none"
            />
            <div className="flex items-center justify-between px-2 pb-2">
              <button
                type="button"
                aria-label="Attach image"
                title="Attach image"
                onClick={() => fileInputRef.current?.click()}
                disabled={awaitingEcho !== null}
                className="rounded-md p-2 text-text-faint hover:bg-surface-2 hover:text-text disabled:opacity-40"
              >
                <AttachImageIcon size={16} />
              </button>
              <ChatViewToggles />
              <div className="mr-auto flex items-center">
                {permissionModes.current !== undefined && (
                  <PermissionModeMenu
                    current={permissionModes.current}
                    available={permissionModes.available}
                    disabled={!connected}
                    onSelect={(mode) => send({ type: 'permission-mode', mode })}
                  />
                )}
                {efforts.current !== undefined && efforts.available.length > 0 && (
                  <EffortMenu
                    current={efforts.current}
                    available={efforts.available}
                    disabled={!connected}
                    onSelect={(effort) => send({ type: 'effort', effort })}
                  />
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  attach([...(e.target.files ?? [])])
                  e.target.value = ''
                }}
              />
              {/* One group, so Stop stays beside Send however the row spreads. */}
              <div className="flex items-center">
                {usage !== undefined && <ContextMeter used={usage.used} size={usage.size} />}
                {busy && (
                  <button
                    type="button"
                    aria-label="Stop turn"
                    title="Stop"
                    onClick={() => send({ type: 'cancel' })}
                    className="mr-1.5 flex size-8 items-center justify-center rounded-full bg-text text-bg hover:opacity-90"
                  >
                    <StopIcon size={11} fill="currentColor" />
                  </button>
                )}
                <button
                  type="button"
                  aria-label="Send"
                  title="Send (Enter)"
                  onClick={() => submit()}
                  disabled={(draft.trim() === '' && images.length === 0) || !connected || awaitingEcho !== null}
                  className="flex size-8 items-center justify-center rounded-full bg-text text-bg
                    hover:opacity-90 disabled:bg-surface-3 disabled:text-text-faint"
                >
                  <SendIcon size={15} strokeWidth={2.5} />
                </button>
              </div>
            </div>
          </>
        )}
      </ChatBottomBar>
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

/** A thread waiting on a permission answer: running, but not "working…". */
function awaitingPermission(groups: readonly Group[]): boolean {
  return groups.some((g) => g.kind === 'permission' && g.decided === undefined)
}

/** Under a running thread, in place of a TUI's spinner. */
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

/** The main conversation's latest context report. */
function contextUsage(events: readonly AcpEvent[]): { used: number; size: number } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === 'usage' && e.thread === undefined) return e
  }
  return undefined
}

/** A token count in short form: 53.2k, 1m. */
function tokens(n: number): string {
  if (n >= 1e6) return `${String(Math.round(n / 1e5) / 10)}m`
  if (n >= 1e3) return `${String(Math.round(n / 100) / 10)}k`
  return String(n)
}

/** How full the main conversation's context window is, as a ring and a
 *  token count, from the agent's last `usage` report. Clicking it toggles
 *  the longer form with the percentage. */
function ContextMeter({ used, size }: { used: number; size: number }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const fraction = Math.min(1, used / size)
  const percent = Math.round(fraction * 100)
  const label = `Context: ${tokens(used)} of ${tokens(size)} tokens (${String(percent)}%)`
  const circumference = 2 * Math.PI * 6
  return (
    <button
      type="button"
      role="meter"
      aria-label="Context used"
      aria-valuenow={percent}
      aria-valuetext={label}
      aria-expanded={expanded}
      onClick={() => setExpanded((e) => !e)}
      className={clsx(
        'mr-2 flex items-center gap-1 rounded-md px-1 py-0.5 text-xs tabular-nums hover:bg-surface-2',
        percent >= 90 ? 'text-error' : percent >= 75 ? 'text-warning' : 'text-text-faint',
      )}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" className="-rotate-90">
        <circle cx="8" cy="8" r="6" fill="none" strokeWidth="2" className="stroke-surface-3" />
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          strokeWidth="2"
          stroke="currentColor"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
        />
      </svg>
      {expanded ? label : `${tokens(used)} / ${tokens(size)}`}
    </button>
  )
}

/**
 * A message waiting for the running turn to end, drawn like the user bubble
 * it becomes but faded. Removing it drops it before the agent sees it.
 */
function QueuedMessage({ prompt, onRemove }: { prompt: AcpQueuedPrompt; onRemove: () => void }): JSX.Element {
  return (
    <div className="mt-3 flex items-start gap-1.5 text-sm opacity-60">
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-xl border border-dashed border-accent/40 px-3 py-2 text-text">
        {prompt.text}
        {prompt.images > 0 && (
          <span className="text-text-faint">
            {prompt.text === '' ? '' : ' '}
            [{prompt.images} {prompt.images === 1 ? 'image' : 'images'}]
          </span>
        )}
        <div className="mt-0.5 text-[11px] text-text-faint">queued until the agent finishes</div>
      </div>
      <button
        type="button"
        aria-label="Remove queued message"
        title="Remove"
        onClick={onRemove}
        className="mt-1 rounded-md p-1 text-text-faint hover:bg-surface-2 hover:text-text"
      >
        <CloseIcon size={12} />
      </button>
    </div>
  )
}

/** An image attached to the draft, removable until the message is sent. */
function DraftImage({ image, workspaceId, onRemove }: {
  image: AcpImage
  workspaceId: string
  onRemove?: () => void
}): JSX.Element {
  return (
    <div className="relative">
      <img src={useImageSrc(image, workspaceId)} alt="" className="h-14 rounded-lg border border-hairline" />
      {onRemove && (
        <button
          type="button"
          aria-label="Remove image"
          onClick={onRemove}
          className="absolute -top-1.5 -right-1.5 rounded-full border border-hairline bg-surface-2
            p-0.5 text-text-dim hover:text-text"
        >
          <CloseIcon size={10} />
        </button>
      )}
    </div>
  )
}
