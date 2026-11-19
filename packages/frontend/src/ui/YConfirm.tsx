import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { AlertDialog } from '@base-ui/react/alert-dialog'
import { useOpenerFocus } from '#lib/useOpenerFocus'
import { yButtonClass } from './YButton'
import { YInput } from './YInput'

/**
 * Destructive-action confirm dialog. The caller controls `open` so it can
 * keep the dialog up during an async action; `busy` disables the buttons.
 *
 * The confirm button takes initial focus, so Enter confirms (e.g. Alt+D,
 * Enter). `confirmText` instead requires typing that exact text first, and
 * focuses the input. `requireClick` focuses Cancel and ignores key
 * activation of confirm, for cases where a stray Enter must never confirm.
 */
export function YConfirm({
  open,
  onOpenChange,
  title,
  description,
  confirmText,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  destructive = true,
  busy = false,
  blocked = false,
  requireClick = false,
  error,
  children,
  alternative,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  /** Exact text the user must type to enable the confirm button. */
  confirmText?: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  busy?: boolean
  /** Keeps confirm disabled until the dialog's own fields are filled in. */
  blocked?: boolean
  requireClick?: boolean
  /** Why the last confirm failed, shown above the buttons. */
  error?: string
  /** Extra content between the description and the buttons. */
  children?: ReactNode
  /** A third button, between Cancel and confirm. */
  alternative?: { label: string; onClick: () => void }
  onConfirm: () => void
}): JSX.Element {
  const confirmRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const finalFocus = useOpenerFocus(open)
  const [typed, setTyped] = useState('')
  useEffect(() => { if (open) setTyped('') }, [open])
  // An empty confirmText never matches, so unloaded data fails closed.
  const unmatched = confirmText !== undefined && (confirmText === '' || typed !== confirmText)
  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="no-drag fixed inset-0 bg-overlay transition-opacity duration-150
          data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <AlertDialog.Popup
          initialFocus={confirmText !== undefined ? inputRef : requireClick ? cancelRef : confirmRef}
          finalFocus={finalFocus}
          className="fixed left-1/2 top-1/2 w-[420px] max-w-[calc(100vw-2rem)] -translate-x-1/2
            -translate-y-1/2 bg-raised p-5 text-text shadow-raised
            outline-none transition duration-150 data-[starting-style]:scale-95 data-[starting-style]:opacity-0
            data-[ending-style]:scale-95 data-[ending-style]:opacity-0"
        >
          <AlertDialog.Title className="text-base font-semibold">{title}</AlertDialog.Title>
          <AlertDialog.Description className="mt-1 text-md leading-relaxed text-muted">
            {description}
          </AlertDialog.Description>
          {confirmText !== undefined && (
            <div className="mt-3">
              <p className="break-all text-md leading-relaxed text-muted">
                Type <span className="font-medium text-text">{confirmText}</span> to confirm.
              </p>
              <YInput
                ref={inputRef}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !busy && !unmatched) onConfirm() }}
                disabled={busy}
                aria-label={`Type ${confirmText} to confirm`}
                className="mt-2 w-full"
              />
            </div>
          )}
          {children}
          {error && <p className="mt-2 text-md text-danger">{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Close ref={cancelRef} disabled={busy} className={yButtonClass('ghost')}>
              {cancelLabel}
            </AlertDialog.Close>
            {alternative && (
              <button type="button" onClick={alternative.onClick} disabled={busy} className={yButtonClass('secondary')}>
                {alternative.label}
              </button>
            )}
            <button
              ref={confirmRef}
              onClick={onConfirm}
              onKeyDown={(e) => { if (requireClick && (e.key === 'Enter' || e.key === ' ')) e.preventDefault() }}
              disabled={busy || unmatched || blocked}
              className={yButtonClass(destructive ? 'danger' : 'primary')}
            >
              {busy ? `${confirmLabel}…` : confirmLabel}
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
