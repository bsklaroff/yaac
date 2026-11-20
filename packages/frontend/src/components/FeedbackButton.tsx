import { useRef, useState, type FormEvent, type JSX } from 'react'
import { useMutation } from '@tanstack/react-query'
import { DraftImage } from '#components/DraftImage'
import { api } from '#lib/api'
import { imageFiles, useDraftImages } from '#lib/attachments'
import { AttachImageIcon, FeedbackIcon } from '#lib/icons'
import { useSnapshotSelect } from '#lib/useSnapshot'
import { windowApi, type ShellApp } from '#lib/platform'
import { YButton, YDialog, YFileInput, YTextArea } from '#ui'

/**
 * Sending feedback: a message, with any
 * screenshots pasted, dropped or picked, which the server forwards signed
 * as this install to its feedback endpoint (docs/feedback.md). The form
 * names that endpoint's host, since it is whatever the server's operator
 * set. Absent on a server with no endpoint.
 */
export function FeedbackButton(): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const host = useSnapshotSelect((s) => s?.feedbackHost ?? null)
  if (host === null) return null
  return (
    <>
      <YButton
        variant="bare"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-3 px-3 py-3 text-left text-base text-muted transition active:bg-selected"
      >
        <FeedbackIcon size={18} />
        <span>Send feedback</span>
      </YButton>
      <FeedbackDialog open={open} onOpenChange={setOpen} />
    </>
  )
}

/** The feedback form in a dialog, opened from the logo menu or the mobile
 *  row. Renders nothing on a server with no endpoint. */
export function FeedbackDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }): JSX.Element | null {
  const host = useSnapshotSelect((s) => s?.feedbackHost ?? null)
  if (host === null) return null
  return (
    <YDialog open={open} onOpenChange={onOpenChange} title="Send feedback" className="flex w-[480px] flex-col gap-3 p-4">
      <FeedbackForm host={host} />
    </YDialog>
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
      <p className="text-sm leading-relaxed text-subtle">
        Goes to <span className="font-mono text-muted">{host}</span>, this server&apos;s feedback
        endpoint, with your name and email (your Tailscale login, or else your git
        identity), the versions of this server and app, the server&apos;s driver, and your browser. Paste
        or drop screenshots to include them.
      </p>
      <YTextArea
        value={message}
        onChange={(e) => { setMessage(e.target.value); send.reset() }}
        onPaste={(e) => attachFrom(imageFiles(e.clipboardData), e)}
        rows={6}
        maxLength={10_000}
        autoFocus
        placeholder="What's working, what isn't, what you'd like to see…"
        className="mt-3 w-full resize-y"
      />
      {images.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {images.map((image, i) => (
            <DraftImage key={i} image={image} onRemove={() => setImages((cur) => cur.filter((_, j) => j !== i))} />
          ))}
        </div>
      )}
      <YFileInput
        ref={fileInputRef}
        accept="image/*"
        multiple
        onChange={(e) => {
          attach([...(e.target.files ?? [])])
          e.target.value = ''
        }}
      />
      <div className="mt-2 flex items-center gap-3">
        <YButton variant="primary" type="submit" disabled={send.isPending || message.trim() === ''}>
          {send.isPending ? 'Sending…' : 'Send'}
        </YButton>
        <YButton variant="ghost" icon={AttachImageIcon} onClick={() => fileInputRef.current?.click()}>
          Attach image
        </YButton>
        {send.isSuccess && <span className="text-md text-subtle">Thanks — sent.</span>}
        {imageError !== null && <span className="text-md text-danger">Image not attached: {imageError}</span>}
        {send.error && <span className="text-md text-danger">{send.error.message}</span>}
      </div>
    </form>
  )
}
