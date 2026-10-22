import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import clsx from 'clsx'
import { useAcpStream } from '#lib/acp'
import { ActivityBar } from '#components/AcpActivity'
import { useComposerMenu } from '#components/ComposerMenu'
import { tokenCount } from '#components/AcpTranscript'
import {
  ChatBottomBar, ChatViewToggles, COMPOSER_INPUT, JumpButtons, Launching, PageLoading, ROUND_BUTTON, useChatColumn,
  useConversationView, useFollowTail,
} from '#components/ConversationView'
import { FileLinksContext, type FileLinks } from '#components/Markdown'
import { EffortSelect, PermissionModeSelect } from '#components/ComposerSelect'
import { imageBytes, imageFiles, prepareImage, toAcpImage, useImageSrc } from '#lib/attachments'
import { dialogHoldsFocus } from '#lib/dialogFocus'
import { focusRaisesKeyboard } from '#lib/viewport'
import { DISCONNECT_NOTICE_DELAY_MS } from '#lib/reconnect'
import { AttachImageIcon, CloseIcon, SendIcon, StopIcon } from '#lib/icons'
import { chatDraftKey, useUiStore } from '#lib/store'
import { useTranscriptPages } from '#lib/useTranscriptPages'
import { useWorkspaceFiles } from '#lib/useWorkspaceChanges'
import { MAX_ATTACHMENT_BYTES } from '@yaac/shared/attachments'
import type { AcpContent, AcpEvent, AcpImage, AcpQueuedPrompt } from '@yaac/shared/acp'

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
 * (`FileLinksContext`), matched against the listing `GitStatusBar` keeps
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

export function WorkspaceChat({ workspaceId, agentSessionId, visible, focused }: {
  workspaceId: string
  agentSessionId: string
  visible: boolean
  /** The pane the user is in, which Cmd/Ctrl-F searches. */
  focused: boolean
}): JSX.Element {
  const stream = useAcpStream(workspaceId, agentSessionId)
  const { events, busy, queued, connected, refused, send, permissionModes, efforts } = stream
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
  const launchPrompt = useUiStore((s) => s.launches[workspaceId]?.prompt)
  const endLaunch = useUiStore((s) => s.endLaunch)
  const setChatSent = useUiStore((s) => s.setChatSent)
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
  const listing = useWorkspaceFiles(workspaceId)
  /** Keyed on the fields links read, so a listing change elsewhere (its
   *  ignored entries) does not re-render every link in the transcript. */
  const root = listing?.root
  const paths = listing?.paths
  const fileLinks = useMemo((): FileLinks | null => root !== undefined && paths ? {
    root,
    paths: new Set(paths),
    open: ({ path, line }) => useUiStore.getState().openFile(workspaceId, path, line),
  } : null, [root, paths, workspaceId])
  const usage = useMemo(() => contextUsage(events), [events])
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const pages = useTranscriptPages({ workspaceId, agentSessionId, life: stream.life, last: stream.page, lastEvents: events, scrollRef })
  const { view, open, activity, groups, findBar, body, titleBar } = useConversationView({
    workspaceId,
    events: pages.events,
    // A turn runs at the end, which an earlier page does not show.
    busy: busy && pages.atEnd,
    stream,
    scrollRef,
    find: { chord: focused, onClose: () => inputRef.current?.focus() },
    visible,
  })

  const { onScroll, keep, pin } = useFollowTail(scrollRef, pages, view)

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
    setChatDraft(workspaceId, agentSessionId, draft)
  }, [draft, workspaceId, agentSessionId, setChatDraft])

  /** The create's prompt stands in for the conversation until the agent
   *  echoes it (or fails), so the create's spinner carries on unbroken. */
  const started = events.some((e) => (e.type === 'user' && e.thread === undefined) || e.type === 'error')
  const launching = launchPrompt !== undefined && !started
  useEffect(() => {
    if (started && launchPrompt !== undefined) endLaunch(workspaceId, 'prompt')
  }, [started, launchPrompt, workspaceId, endLaunch])

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
      pin()
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
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="flex-1 overflow-y-auto px-4 py-4"
        >
          {view === undefined && groups.length === 0 && pages.loading === undefined && !launching && (
            <div className="flex h-full items-center justify-center text-xs text-text-faint">
              {connected ? 'No messages yet — say something.' : 'Connecting to the agent…'}
            </div>
          )}
          <FileLinksContext.Provider value={fileLinks}>
            <div className={column}>
              {pages.loading === 'earlier' && <PageLoading />}
              {view === undefined && launching && <Launching prompt={launchPrompt} />}
              {body}
              {pages.loading === 'later' && <PageLoading />}
              {view === undefined && pages.atEnd && queued.map((q) => (
                <QueuedMessage key={q.id} prompt={q} onRemove={() => send({ type: 'unqueue', id: q.id })} />
              ))}
            </div>
          </FileLinksContext.Provider>
        </div>
        {view === undefined && <JumpButtons pages={pages} />}
      </div>

      <ChatBottomBar
        above={
          <>
            {dropped && (
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
        {titleBar ?? (
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
              placeholder={connected ? 'Message the agent…' : dropped ? 'Reconnecting…' : 'Connecting…'}
              readOnly={awaitingEcho !== null}
              className={COMPOSER_INPUT}
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
                  <PermissionModeSelect
                    current={permissionModes.current}
                    available={permissionModes.available}
                    disabled={!connected}
                    onSelect={(mode) => send({ type: 'permission-mode', mode })}
                  />
                )}
                {efforts.current !== undefined && efforts.available.length > 0 && (
                  <EffortSelect
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
                    className={clsx(ROUND_BUTTON, 'mr-1.5')}
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
                  className={ROUND_BUTTON}
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
    <button
      type="button"
      role="meter"
      aria-label="Context used"
      aria-valuenow={percent}
      aria-valuetext={label}
      aria-expanded={expanded}
      onClick={() => setExpanded((e) => !e)}
      className={clsx(
        'mr-2 flex items-center gap-1 whitespace-nowrap rounded-md px-1 py-0.5 text-xs tabular-nums',
        'hover:bg-surface-2',
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
      <span className={expanded ? '@min-[30rem]:hidden' : 'hidden @min-[30rem]:inline'}>{short}</span>
      {expanded && <span className="hidden @min-[30rem]:inline">{label}</span>}
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
