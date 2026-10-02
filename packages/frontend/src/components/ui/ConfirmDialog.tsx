import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import clsx from 'clsx'
import { AlertDialog } from '@base-ui/react/alert-dialog'
import { useOpenerFocus } from '#lib/useOpenerFocus'

/**
 * Destructive-action confirm dialog. The caller controls `open` so it can
 * keep the dialog up during an async action; `busy` disables the buttons.
 *
 * The confirm button takes initial focus, so Enter confirms (e.g. Alt+D,
 * Enter). `confirmText` instead requires typing that exact text first, and
 * focuses the input. `requireClick` focuses Cancel and ignores key
 * activation of confirm, for cases where a stray Enter must never confirm.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  destructive = true,
  busy = false,
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
        <AlertDialog.Backdrop className="fixed inset-0 bg-black/60 backdrop-blur-[1px] transition-opacity duration-150
          data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <AlertDialog.Popup
          initialFocus={confirmText !== undefined ? inputRef : requireClick ? cancelRef : confirmRef}
          finalFocus={finalFocus}
          className="fixed left-1/2 top-1/2 w-[400px] max-w-[calc(100vw-2rem)] -translate-x-1/2
            -translate-y-1/2 rounded-lg border border-border bg-surface-2 p-5 text-text shadow-[0_16px_48px_var(--shadow-color)]
            outline-none transition duration-150 data-[starting-style]:scale-95 data-[starting-style]:opacity-0
            data-[ending-style]:scale-95 data-[ending-style]:opacity-0"
        >
          <AlertDialog.Title className="text-sm font-semibold">{title}</AlertDialog.Title>
          <AlertDialog.Description className="mt-1 text-xs leading-relaxed text-text-dim">
            {description}
          </AlertDialog.Description>
          {confirmText !== undefined && (
            <div className="mt-3">
              <p className="break-all text-xs leading-relaxed text-text-dim">
                Type <span className="font-medium text-text">{confirmText}</span> to confirm.
              </p>
              <input
                ref={inputRef}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !busy && !unmatched) onConfirm() }}
                disabled={busy}
                aria-label={`Type ${confirmText} to confirm`}
                className="mt-2 w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-text
                  outline-none focus:border-border-strong"
              />
            </div>
          )}
          {children}
          {error && <p className="mt-2 text-xs text-danger">{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Close
              ref={cancelRef}
              disabled={busy}
              className="flex h-8 items-center rounded-md px-3 text-xs text-text-dim transition
                hover:bg-surface-3 hover:text-text disabled:opacity-50"
            >
              {cancelLabel}
            </AlertDialog.Close>
            {alternative && (
              <button
                type="button"
                onClick={alternative.onClick}
                disabled={busy}
                className="flex h-8 items-center rounded-md px-3 text-xs text-text-dim transition
                  hover:bg-surface-3 hover:text-text disabled:opacity-50"
              >
                {alternative.label}
              </button>
            )}
            <button
              ref={confirmRef}
              onClick={onConfirm}
              onKeyDown={(e) => { if (requireClick && (e.key === 'Enter' || e.key === ' ')) e.preventDefault() }}
              disabled={busy || unmatched}
              className={clsx(
                'flex h-8 items-center rounded-md px-3 text-xs font-medium transition disabled:opacity-50',
                destructive
                  ? 'bg-[#c94a4a] text-white hover:bg-danger'
                  : 'bg-accent text-bg hover:brightness-110',
              )}
            >
              {busy ? `${confirmLabel}…` : confirmLabel}
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
