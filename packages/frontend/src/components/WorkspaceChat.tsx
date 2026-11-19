import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import clsx from 'clsx'
import { useAcpStream } from '#lib/acp'
import type { Opening } from '#lib/opening'
import { ActivityBar } from '#components/AcpActivity'
import { sessionModels, useComposerMenu } from '#components/ComposerMenu'
import { PendingAsks, tokenCount } from '#components/AcpTranscript'
import {
  ChatBottomBar, ChatViewToggles, COMPOSER_INPUT, FilledStopIcon, JumpButtons, Launching, PageFailed, PageLoading, useChatColumn,
  useConversationView, useFollowTail,
} from '#components/ConversationView'
import { FileLinksContext, useFileLinks } from '#components/Markdown'
import { AgentSettings, PermissionModeSelect } from '#components/ComposerSettings'
import { imageFiles, useDraftImages } from '#lib/attachments'
import { DraftImage } from '#components/DraftImage'
import { dialogHoldsFocus } from '#lib/dialogFocus'
import { focusRaisesKeyboard } from '#lib/viewport'
import { DISCONNECT_NOTICE_DELAY_MS } from '#lib/reconnect'
import { AttachImageIcon, CloseIcon, SendIcon } from '#lib/icons'
import { YButton, YFileInput, YTextArea } from '#ui'
import { chatDraftKey, useUiStore } from '#lib/store'
import { useTranscriptPages } from '#lib/useTranscriptPages'
import { useSnapshot } from '#lib/useSnapshot'
import { setSessionAgentOptions } from '#lib/createWorkspace'
import { agentOptionIsLive, toolAgentOptions } from '@yaac/shared/types'
import type { AcpContent, AcpEvent, AcpQueuedPrompt } from '@yaac/shared/acp'

/**
 * The chat pane for an `acp` conversation; `WorkspaceTerminal` fills the
 * same slot for `tui`. Like the terminal, it stays mounted with its socket
 * open while off-screen, because re-attaching is slow on a bad link;
 * `visible` only decides focus. The draft lives in the ui store so it
 * survives the pane unmounting or a reload.
 *
 * What it shows, including the subagents and background tasks it can
 * switch to and the find bar, is `useConversationView`'s, and which pages of
 * the conversation `useTranscriptPages`', both shared with the read-only
 * pane. This component owns the stream, the draft, the composer and
 * scroll-follow; the composer's completion menu is `useComposerMenu`'s.
 * A subagent's or task's title bar takes the composer's place, since the
 * agent takes messages only on its main thread.
 *
 * Paths of checkout files in the transcript open the file pane
 * (`FileLinksContext`), matched against the listing `GitTopBarSummary` keeps
 * current.
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

export function WorkspaceChat({ workspaceId, conversationId, opening, onStarted, visible, focused }: {
  workspaceId: string
  conversationId: string
  /** The message its session was opened with, when this tab drew that
   *  session starting (`wasDrawnStarting`). */
  opening?: Opening
  /** Called once the conversation has started, when no later mount should
   *  carry the opening message on. */
  onStarted?: () => void
  visible: boolean
  /** The pane the user is in, which Cmd/Ctrl-F searches. */
  focused: boolean
}): JSX.Element {
  const stream = useAcpStream(workspaceId, conversationId)
  const { events, busy, queued, connected, refused, send, permissionModes, efforts } = stream
  // The session holding this conversation, whose agent options it can
  // change while it runs (docs/sessions.md, "Agent options").
  const session = useSnapshot()?.workspaces.find((w) => w.workspaceId === workspaceId)
    ?.sessions.find((s) => s.conversationId === conversationId)
  const [optionError, setOptionError] = useState<string | null>(null)
  /**
   * Whether to say the pane is disconnected: only once an attach it had, or
   * the server's refusal of one, is `DISCONNECT_NOTICE_DELAY_MS` old, as a
   * terminal does. Most drops heal sooner, and a stopping workspace's pane
   * is replaced sooner. Until then the pane is connecting, since a starting
   * workspace's pane mounts before its conversation is live and the server
   * holds its attach until it is.
   */
  const [dropped, setDropped] = useState(false)
  const attachedRef = useRef(false)
  useEffect(() => {
    if (connected) {
      attachedRef.current = true
      setDropped(false)
      return
    }
    if (!attachedRef.current && !refused) return
    const timer = setTimeout(() => setDropped(true), DISCONNECT_NOTICE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [connected, refused])
  const setChatDraft = useUiStore((s) => s.setChatDraft)
  const setChatSent = useUiStore((s) => s.setChatSent)
  const column = useChatColumn()
  /**
   * The draft is local state mirrored into the store, so typing needs no
   * store round trip. The pane is keyed by conversation, so seeding once on
   * mount is enough.
   */
  const [draft, setDraft] = useState(
    () => useUiStore.getState().chatDrafts[chatDraftKey(workspaceId, conversationId)]?.text ?? '',
  )
  /**
   * A message sent on the socket but not yet echoed back as a `user` event.
   * The text stays in the box until the echo arrives, so a dropped connection
   * leaves it there to send again.
   */
  const [awaitingEcho, setAwaitingEcho] = useState<string | null>(null)
  /** Images attached to the draft (docs/agent-modes.md, "Images"). */
  const { images, setImages, error: imageError, attach } = useDraftImages()
  const fileInputRef = useRef<HTMLInputElement>(null)
  /** The draft and in-flight message this pane mounted with, and whether
   *  they have been checked against the replayed history yet. */
  const restoredRef = useRef(draft)
  const restoredSentRef = useRef(
    useUiStore.getState().chatDrafts[chatDraftKey(workspaceId, conversationId)]?.sent,
  )
  const reconciledRef = useRef(false)
  const fileLinks = useFileLinks(workspaceId, session?.cwd)
  const usage = useMemo(() => contextUsage(events), [events])
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const pages = useTranscriptPages({ workspaceId, conversationId, life: stream.life, last: stream.page, lastEvents: events, scrollRef })
  const { view, open, activity, groups, answerPermission, findBar, body, titleBar } = useConversationView({
    workspaceId,
    events: pages.events,
    // A turn runs at the end, which an earlier page does not show.
    busy: busy && pages.atEnd,
    stream,
    scrollRef,
    find: { chord: focused, onClose: () => inputRef.current?.focus() },
    visible,
  })

  const { onScroll, keep, pin, unseen } = useFollowTail(scrollRef, pages, view)

  // Grow the textarea to fit the draft, up to its CSS max-height. Reset to
  // `auto` first so scrollHeight measures the content. Growing shrinks the
  // conversation, so keep a reader at the tail pinned there. The textarea
  // remounts on leaving a subagent's or task's view, so that refits too.
  const fitInput = useCallback(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
    keep()
  }, [keep])
  useLayoutEffect(fitInput, [draft, view, fitInput])

  /**
   * Refit when the box's width changes too, or a box first laid out narrow
   * (a web view sized late, a rotated phone, a tiles column since widened)
   * keeps the height of its wrapped placeholder or draft until the next
   * keystroke. Height changes are ignored, since the fit makes them.
   */
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    let width = el.clientWidth
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return
      width = el.clientWidth
      fitInput()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [view, fitInput])

  useEffect(() => {
    if (!visible || dialogHoldsFocus() || focusRaisesKeyboard()) return
    inputRef.current?.focus()
  }, [visible, view])

  useEffect(() => {
    setChatDraft(workspaceId, conversationId, draft)
  }, [draft, workspaceId, conversationId, setChatDraft])

  /**
   * What stands in for the conversation: a spinner saying the pane is
   * connecting until there is something to show, then, for a session that
   * opened with a message, one saying the agent is working until it echoes
   * that message (or fails), so the session's start shows no gap. Only a
   * conversation whose history is all one page can still be waiting on its
   * echo.
   */
  const started = stream.page > 0
    || events.some((e) => (e.type === 'user' && e.thread === undefined) || e.type === 'error')
  const standIn = view !== undefined ? undefined
    : !connected && groups.length === 0 ? { caption: 'connecting' }
    : opening !== undefined && !started ? {}
    : undefined
  /** Nothing to show yet. Past page 0 that means the pages before are still
   *  to be read (an agent restart's new life can start with an empty last
   *  page), so only a conversation shown from its first page is empty. */
  const empty = view === undefined && groups.length === 0 && standIn === undefined
  useEffect(() => {
    if (started) onStarted?.()
  }, [started, onStarted])

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
    setChatSent(workspaceId, conversationId, undefined)
    if (restoredRef.current.trim() !== sent) return
    let lastUser: string | undefined
    for (const e of events) if (e.type === 'user' && e.thread === undefined) lastUser = promptText(e.content)
    if (lastUser !== sent && !queued.some((q) => q.text === sent)) return
    // Keep anything typed while connecting.
    setDraft((cur) => (cur === restoredRef.current ? '' : cur))
  }, [connected, events, queued, workspaceId, conversationId, setChatSent])

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
      setChatSent(workspaceId, conversationId, undefined)
    }
  }, [events, queued, awaitingEcho, workspaceId, conversationId, setChatSent])

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
      setChatSent(workspaceId, conversationId, text)
      pin()
    }
  }

  const models = sessionModels(events)
  const { menu, inputProps: menuInputProps, onKeyDown: menuKeyDown } = useComposerMenu({
    inputRef,
    draft,
    events,
    disabled: awaitingEcho !== null,
    setDraft,
    runCommand: submit,
    switchModel: (modelId) => send({ type: 'model', modelId }),
  })

  return (
    <div
      className="@container flex h-full w-full flex-col bg-surface"
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
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="flex-1 overflow-y-auto px-4 py-4"
        >
          {empty && pages.fromStart && pages.loading === undefined && (
            <div className="flex h-full items-center justify-center text-md text-subtle">
              No messages yet — say something.
            </div>
          )}
          <FileLinksContext.Provider value={fileLinks}>
            <div className={column}>
              {empty && !pages.fromStart && pages.failed
                ? <PageFailed onRetry={pages.retry} />
                : (pages.loading === 'earlier' || (empty && !pages.fromStart)) && <PageLoading />}
              {standIn !== undefined && <Launching {...opening} {...standIn} />}
              {body}
              {pages.loading === 'later' && <PageLoading />}
              {view === undefined && pages.atEnd && queued.map((q) => (
                <QueuedMessage key={q.id} prompt={q} onRemove={() => send({ type: 'unqueue', id: q.id })} />
              ))}
            </div>
          </FileLinksContext.Provider>
        </div>
        {view === undefined && <JumpButtons pages={pages} unseen={unseen} />}
      </div>

      <ChatBottomBar
        above={
          <>
            {dropped && (
              <div className="mb-1.5 px-1 text-md text-subtle">
                Disconnected — the agent keeps working; this pane reattaches automatically.
              </div>
            )}
            {view?.kind !== 'task' && answerPermission !== undefined && (
              <PendingAsks workspaceId={workspaceId} groups={groups} onAnswer={answerPermission} />
            )}
            <ActivityBar
              subagents={activity.subagents}
              tasks={activity.tasks}
              {...(view !== undefined ? { current: view } : {})}
              onOpen={open}
            />
            {view === undefined && imageError !== null && (
              <div className="mb-1.5 px-1 text-md text-danger">Image not attached: {imageError}</div>
            )}
            {view === undefined && optionError !== null && (
              <div className="mb-1.5 px-1 text-md text-danger">Option not changed: {optionError}</div>
            )}
            {view === undefined && menu}
          </>
        }
        onClick={(e) => {
          if (e.target === e.currentTarget) inputRef.current?.focus()
        }}
      >
        {titleBar ?? (
          <>
            {images.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-3 pt-3">
                {images.map((image, i) => (
                  <DraftImage
                    key={i}
                    image={image}
                    {...(awaitingEcho === null
                      ? { onRemove: () => setImages((cur) => cur.filter((_, j) => j !== i)) }
                      : {})}
                  />
                ))}
              </div>
            )}
            <YTextArea
              bare
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
              placeholder={connected ? 'Message the agent…' : dropped ? 'Reconnecting…' : 'Connecting…'}
              readOnly={awaitingEcho !== null}
              className={COMPOSER_INPUT}
            />
            <div className="flex items-center justify-between px-2 pb-2">
              <YButton
                variant="ghost"
                icon={AttachImageIcon}
                aria-label="Attach image"
                title="Attach image"
                onClick={() => fileInputRef.current?.click()}
                disabled={awaitingEcho !== null}
              />
              <ChatViewToggles />
              <div className="mr-auto flex min-w-0 items-center">
                {permissionModes.current !== undefined && (
                  <PermissionModeSelect
                    current={permissionModes.current}
                    available={permissionModes.available}
                    disabled={!connected}
                    onSelect={(mode) => send({ type: 'permission-mode', mode })}
                  />
                )}
                <AgentSettings
                  disabled={!connected}
                  model={models.models.length > 0
                    ? {
                      current: models.current,
                      items: models.models,
                      onSelect: (modelId) => send({ type: 'model', modelId }),
                      tag: (id) => id === models.current && 'current',
                    }
                    : undefined}
                  effort={efforts.current !== undefined && efforts.available.length > 0
                    ? { current: efforts.current, available: efforts.available, onSelect: (effort) => send({ type: 'effort', effort }) }
                    : undefined}
                  options={session !== undefined
                    ? {
                      list: toolAgentOptions(session.tool).filter((o) => agentOptionIsLive(o, session.mode)),
                      value: session.agentOptions,
                      onChange: (o) => {
                        setSessionAgentOptions(workspaceId, session.sessionId, o).then(
                          () => setOptionError(null),
                          (err: unknown) => setOptionError(err instanceof Error ? err.message : String(err)),
                        )
                      },
                    }
                    : undefined}
                />
              </div>
              <YFileInput
                ref={fileInputRef}
                accept="image/*"
                multiple
                onChange={(e) => {
                  attach([...(e.target.files ?? [])])
                  e.target.value = ''
                }}
              />
              {/* One group, so Stop stays beside Send however the row spreads. */}
              <div className="flex items-center">
                {usage !== undefined && <ContextMeter used={usage.used} size={usage.size} />}
                {busy && (
                  <YButton
                    variant="primary"
                    icon={FilledStopIcon}
                    aria-label="Stop turn"
                    title="Stop"
                    onClick={() => send({ type: 'cancel' })}
                    className="mr-1.5"
                  />
                )}
                <YButton
                  variant="primary"
                  icon={SendIcon}
                  aria-label="Send"
                  title="Send (Enter)"
                  onClick={() => submit()}
                  disabled={(draft.trim() === '' && images.length === 0) || !connected || awaitingEcho !== null}
                />
              </div>
            </div>
          </>
        )}
      </ChatBottomBar>
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

/** How full the main conversation's context window is, as a ring and a
 *  token count, from the agent's last `usage` report. Clicking it toggles
 *  the longer form with the percentage. A narrow pane shows one step less
 *  of each (the bare ring, then the token count), so the composer's footer
 *  fits on one line. */
function ContextMeter({ used, size }: { used: number; size: number }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const fraction = Math.min(1, used / size)
  const percent = Math.round(fraction * 100)
  const label = `Context: ${tokenCount(used)} of ${tokenCount(size)} tokens (${String(percent)}%)`
  const short = `${tokenCount(used)} / ${tokenCount(size)}`
  const circumference = 2 * Math.PI * 6
  return (
    <YButton
      variant="bare"
      role="meter"
      aria-label="Context used"
      aria-valuenow={percent}
      aria-valuetext={label}
      aria-expanded={expanded}
      onClick={() => setExpanded((e) => !e)}
      className={clsx(
        'mr-1 flex items-center gap-1 whitespace-nowrap rounded-md px-1 py-0.5 text-md tabular-nums @min-[30rem]:mr-2',
        'hover:bg-hover',
        percent >= 90 ? 'text-danger' : percent >= 75 ? 'text-warning' : 'text-subtle',
      )}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" className="-rotate-90">
        <circle cx="8" cy="8" r="6" fill="none" strokeWidth="2" className="stroke-line-strong" />
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
      <span className={expanded ? '@min-[30rem]:hidden' : 'hidden @min-[30rem]:inline'}>{short}</span>
      {expanded && <span className="hidden @min-[30rem]:inline">{label}</span>}
    </YButton>
  )
}

/**
 * A message waiting for the running turn to end, drawn like the user bubble
 * it becomes but faded. Removing it drops it before the agent sees it.
 */
function QueuedMessage({ prompt, onRemove }: { prompt: AcpQueuedPrompt; onRemove: () => void }): JSX.Element {
  return (
    <div className="mt-3 flex items-start gap-1.5 text-base opacity-60">
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-xl border border-dashed border-accent/40 px-3 py-2 text-text">
        {prompt.text}
        {prompt.images > 0 && (
          <span className="text-subtle">
            {prompt.text === '' ? '' : ' '}
            [{prompt.images} {prompt.images === 1 ? 'image' : 'images'}]
          </span>
        )}
        <div className="mt-0.5 text-sm text-subtle">queued until the agent finishes</div>
      </div>
      <YButton
        variant="ghost"
        size="sm"
        icon={CloseIcon}
        aria-label="Remove queued message"
        title="Remove"
        onClick={onRemove}
        className="mt-1"
      />

    </div>
  )
}
