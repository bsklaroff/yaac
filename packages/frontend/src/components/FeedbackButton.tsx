import { useRef, useState, type FormEvent, type JSX } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Modal } from '#components/ui/Modal'
import { DraftImage } from '#components/ui/DraftImage'
import { api } from '#lib/api'
import { imageFiles, useDraftImages } from '#lib/attachments'
import { AttachImageIcon, FeedbackIcon } from '#lib/icons'
import { useSnapshot } from '#lib/useSnapshot'
import { windowApi, type ShellApp } from '#lib/platform'

/**
 * The rail's feedback button and its dialog: a message, with any
 * screenshots pasted, dropped or picked, which the server forwards signed
 * as this install to its feedback endpoint (docs/feedback.md). The form
 * names that endpoint's host, since it is whatever the server's operator
 * set. Absent on a server with no endpoint.
 */
export function FeedbackButton(
  /** 'rail' is the desktop rail's 40px chip; 'row' is the mobile project
   *  screen's full-width labelled row. */
  { variant = 'rail' }: { variant?: 'rail' | 'row' } = {},
): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const host = useSnapshot()?.feedbackHost ?? null
  if (host === null) return null
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Send feedback"
        aria-label="Send feedback"
        className={variant === 'row'
          ? 'flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm text-text-dim transition '
            + 'active:bg-surface-2'
          : 'flex h-10 w-10 items-center justify-center rounded-[20px] text-text-faint transition-all '
            + 'hover:rounded-xl hover:text-text-dim'}
      >
        <FeedbackIcon size={18} />
        {variant === 'row' && <span>Send feedback</span>}
      </button>
      <Modal open={open} onOpenChange={setOpen} title="Send feedback" className="flex w-[480px] flex-col gap-3 p-4">
        <FeedbackForm host={host} />
      </Modal>
    </>
  )
}

/** This webapp build, the browser running it, and the native app around
 *  it if any, sent with each report. */
function thisClient(): { version?: string; gitCommit?: string; userAgent: string; app?: ShellApp } {
  const { YAAC_VERSION: version, YAAC_GIT_COMMIT: gitCommit } = import.meta.env
  const app = windowApi()?.app
  return {
    ...(version ? { version } : {}),
    ...(gitCommit ? { gitCommit } : {}),
    userAgent: navigator.userAgent,
    ...(app ? { app } : {}),
  }
}

function FeedbackForm({ host }: { host: string }): JSX.Element {
  const [message, setMessage] = useState('')
  const { images, setImages, error: imageError, attach } = useDraftImages()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const send = useMutation({
    mutationFn: (text: string) => api.feedback.$post({ json: { message: text, images, client: thisClient() } }),
    onSuccess: () => { setMessage(''); setImages([]) },
  })
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    send.mutate(message.trim())
  }
  const attachFrom = (files: File[], event: { preventDefault: () => void }): void => {
    if (files.length === 0) return
    event.preventDefault()
    send.reset()
    attach(files)
  }

  return (
    <form
      onSubmit={submit}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault() }}
      onDrop={(e) => attachFrom(imageFiles(e.dataTransfer), e)}
    >
      <p className="text-[11px] leading-relaxed text-text-faint">
        Goes to <span className="font-mono text-text-dim">{host}</span>, the feedback endpoint this
        server&apos;s operator set, with your name and email (your Tailscale login, or else your git
        identity), the versions of this server and app, the server&apos;s driver, and your browser. Paste
        or drop screenshots to include them.
      </p>
      <textarea
        value={message}
        onChange={(e) => { setMessage(e.target.value); send.reset() }}
        onPaste={(e) => attachFrom(imageFiles(e.clipboardData), e)}
        rows={6}
        maxLength={10_000}
        autoFocus
        placeholder="What's working, what isn't, what you'd like to see…"
        className="mt-3 w-full resize-y rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-text
          outline-none focus:border-border-strong"
      />
      {images.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {images.map((image, i) => (
            <DraftImage key={i} image={image} onRemove={() => setImages((cur) => cur.filter((_, j) => j !== i))} />
          ))}
        </div>
      )}
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
      <div className="mt-2 flex items-center gap-3">
        <button
          type="submit"
          disabled={send.isPending || message.trim() === ''}
          className="shrink-0 rounded-md bg-surface-3 px-3 py-1.5 text-xs font-medium text-text transition
            hover:bg-border-strong disabled:opacity-50"
        >
          {send.isPending ? 'Sending…' : 'Send'}
        </button>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-1.5 text-xs text-text-faint transition hover:text-text"
        >
          <AttachImageIcon size={13} />
          Attach image
        </button>
        {send.isSuccess && <span className="text-xs text-text-faint">Thanks — sent.</span>}
        {imageError !== null && <span className="text-xs text-red-400">Image not attached: {imageError}</span>}
        {send.error && <span className="text-xs text-red-400">{send.error.message}</span>}
      </div>
    </form>
  )
}
