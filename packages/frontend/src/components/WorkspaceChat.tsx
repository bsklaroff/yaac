import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useAcpStream } from '#lib/acp'
import { AcpTranscript, groupEvents } from '#components/AcpTranscript'
import { imageBytes, imageFiles, prepareImage, toAcpImage, useImageSrc } from '#lib/attachments'
import { AttachImageIcon, CloseIcon, LoadingIcon } from '#lib/icons'
import { chatDraftKey, useUiStore } from '#lib/store'
import { MAX_ATTACHMENT_BYTES } from '@yaac/shared/attachments'
import type { AcpContent, AcpImage } from '@yaac/shared/acp'

/**
 * The chat pane for an `acp` conversation; `WorkspaceTerminal` fills the
 * same slot for `tui`. Like the terminal, it stays mounted with its socket
 * open while off-screen, because re-attaching is slow on a bad link;
 * `visible` only decides focus. The draft lives in the ui store so it
 * survives the pane unmounting or a reload.
 *
 * Rendering is `AcpTranscript`'s job (shared with stopped workspaces). This
 * component owns the stream, the draft, the composer and scroll-follow.
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
}: {
  workspaceId: string
  agentSessionId: string
  visible?: boolean
}): JSX.Element {
  const { events, busy, connected, send } = useAcpStream(workspaceId, agentSessionId)
  const setChatDraft = useUiStore((s) => s.setChatDraft)
  const setChatSent = useUiStore((s) => s.setChatSent)
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
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const inputRef = useRef<HTMLTextAreaElement>(null)

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
  }, [groups])

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
    if (visible) inputRef.current?.focus()
  }, [visible])

  useEffect(() => {
    setChatDraft(workspaceId, agentSessionId, draft)
  }, [draft, workspaceId, agentSessionId, setChatDraft])

  /**
   * On first connect, settle a message a previous mount sent but never saw
   * echoed. Clear the box only if it still holds that exact message (the
   * `sent` marker, so a freshly typed identical text is kept) and the replayed
   * history's last user message matches it. The marker is dropped either way.
   */
  useEffect(() => {
    if (reconciledRef.current || !connected) return
    reconciledRef.current = true
    const sent = restoredSentRef.current
    if (sent === undefined) return
    setChatSent(workspaceId, agentSessionId, undefined)
    if (restoredRef.current.trim() !== sent) return
    let lastUser: string | undefined
    for (const e of events) if (e.type === 'user') lastUser = promptText(e.content)
    if (lastUser !== sent) return
    // Keep anything typed while connecting.
    setDraft((cur) => (cur === restoredRef.current ? '' : cur))
  }, [connected, events, workspaceId, agentSessionId, setChatSent])

  // The server's `user` echo confirms a send and clears the box.
  useEffect(() => {
    if (awaitingEcho === null) return
    const echoed = events.some((e) => e.type === 'user'
      && echoKey(promptText(e.content), e.content.filter((c) => c.type === 'image').length) === awaitingEcho)
    if (echoed) {
      setDraft('')
      setImages([])
      setAwaitingEcho(null)
      setChatSent(workspaceId, agentSessionId, undefined)
    }
  }, [events, awaitingEcho, workspaceId, agentSessionId, setChatSent])

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

  const submit = (): void => {
    const text = draft.trim()
    // Checks `busy` so Enter cannot start a second turn the Send button
    // would block.
    if ((text === '' && images.length === 0) || !connected || busy || awaitingEcho !== null) return
    if (send({ type: 'prompt', text, ...(images.length > 0 ? { images } : {}) })) {
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

  /** Answer a permission ask. Returns whether it was sent, so the card can
   *  re-offer its buttons if the socket was down. */
  const answerPermission = (requestId: string, optionId?: string): boolean =>
    send({ type: 'permission', requestId, ...(optionId !== undefined ? { optionId } : {}) })

  /** A turn waiting on a permission answer: busy, but not "working…". */
  const awaitingPermission = groups.some((g) => g.kind === 'permission' && g.decided === undefined)

  return (
    <div
      className="flex h-full w-full flex-col bg-bg"
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
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto px-3 py-2.5"
      >
        {groups.length === 0 && (
          <div className="flex h-full items-center justify-center text-xs text-text-faint">
            {connected ? 'No messages yet — say something.' : 'Connecting to the agent…'}
          </div>
        )}
        <AcpTranscript groups={groups} onAnswerPermission={answerPermission} />
        {busy && !awaitingPermission && (
          <div className="mt-2.5 flex items-center gap-1.5 text-xs text-text-dim">
            <LoadingIcon size={12} className="animate-spin" />
            <span>
              working
              <span className="working-dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span>
            </span>
          </div>
        )}
      </div>

      <div className="border-t border-hairline p-2">
        {!connected && (
          <div className="mb-1.5 text-xs text-text-faint">
            Disconnected — the agent keeps working; this pane reattaches automatically.
          </div>
        )}
        {imageError !== null && (
          <div className="mb-1.5 text-xs text-[#f85149]">Image not attached: {imageError}</div>
        )}
        {images.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1.5">
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
        <div className="flex items-end gap-2">
          <button
            type="button"
            aria-label="Attach image"
            title="Attach image"
            onClick={() => fileInputRef.current?.click()}
            disabled={awaitingEcho !== null}
            className="rounded-md border border-hairline p-1.5 text-text-dim hover:text-text disabled:opacity-40"
          >
            <AttachImageIcon size={14} />
          </button>
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
          <textarea
            ref={inputRef}
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
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            placeholder={connected ? 'Message the agent…' : 'Reconnecting…'}
            readOnly={awaitingEcho !== null}
            // index.css raises this to 16px on phones so iOS Safari does not
            // zoom on focus.
            className="max-h-40 min-h-8 flex-1 resize-none rounded-md border border-hairline
              bg-surface-2 px-2.5 py-1.5 text-sm text-text placeholder:text-text-faint
              focus:outline-none"
          />
          {busy ? (
            <button
              type="button"
              onClick={() => send({ type: 'cancel' })}
              className="rounded-md border border-hairline px-2.5 py-1.5 text-xs text-text-dim hover:text-text"
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={(draft.trim() === '' && images.length === 0) || !connected || awaitingEcho !== null}
              className="rounded-md border border-hairline px-2.5 py-1.5 text-xs text-text-dim hover:text-text disabled:opacity-40"
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** An image attached to the draft, removable until the message is sent. */
function DraftImage({ image, onRemove }: { image: AcpImage; onRemove?: () => void }): JSX.Element {
  return (
    <div className="relative">
      <img src={useImageSrc(image)} alt="" className="h-14 rounded border border-hairline" />
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
