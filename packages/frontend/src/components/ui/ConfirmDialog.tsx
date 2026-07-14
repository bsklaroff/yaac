import { useEffect, useRef, useState, type JSX } from 'react'
import clsx from 'clsx'
import { AlertDialog } from '@base-ui/react/alert-dialog'

/**
 * Reusable destructive-confirm dialog (Base UI AlertDialog + design
 * tokens), ported from code-design. Controlled via `open`/`onOpenChange`;
 * the caller owns closing so it can keep the dialog up during an async
 * action and close on success. Pass `busy` to disable the buttons.
 *
 * The confirm button takes initial focus, so a bare Enter confirms —
 * keyboard flows like Alt+D Enter (delete session) complete without the
 * mouse. Esc still cancels, and Tab reaches Cancel.
 *
 * Pass `confirmText` to require typing that exact text before confirm
 * enables (GitHub-style guard for high-blast-radius deletes). The input
 * takes initial focus instead, and Enter confirms once it matches.
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
  onConfirm: () => void
}): JSX.Element {
  const confirmRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [typed, setTyped] = useState('')
  useEffect(() => { if (open) setTyped('') }, [open])
  // An empty confirmText can never match, so a caller whose data hasn't
  // hydrated yet fails closed instead of silently skipping the guard.
  const unmatched = confirmText !== undefined && (confirmText === '' || typed !== confirmText)
  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 bg-black/60 backdrop-blur-[1px] transition-opacity duration-150
          data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <AlertDialog.Popup
          initialFocus={confirmText !== undefined ? inputRef : confirmRef}
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
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Close
              disabled={busy}
              className="flex h-8 items-center rounded-md px-3 text-xs text-text-dim transition
                hover:bg-surface-3 hover:text-text disabled:opacity-50"
            >
              {cancelLabel}
            </AlertDialog.Close>
            <button
              ref={confirmRef}
              onClick={onConfirm}
              disabled={busy || unmatched}
              className={clsx(
                'flex h-8 items-center rounded-md px-3 text-xs font-medium transition disabled:opacity-50',
                destructive
                  ? 'bg-[#c94a4a] text-white hover:bg-[#d65858]'
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
