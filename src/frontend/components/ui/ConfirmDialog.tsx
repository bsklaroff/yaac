import type { JSX } from 'react'
import clsx from 'clsx'
import { AlertDialog } from '@base-ui/react/alert-dialog'

/**
 * Reusable destructive-confirm dialog (Base UI AlertDialog + design
 * tokens), ported from code-design. Controlled via `open`/`onOpenChange`;
 * the caller owns closing so it can keep the dialog up during an async
 * action and close on success. Pass `busy` to disable the buttons.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
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
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  busy?: boolean
  onConfirm: () => void
}): JSX.Element {
  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 bg-black/60 backdrop-blur-[1px] transition-opacity duration-150
          data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <AlertDialog.Popup className="fixed left-1/2 top-1/2 w-[400px] max-w-[calc(100vw-2rem)] -translate-x-1/2
          -translate-y-1/2 rounded-lg border border-border bg-surface-2 p-5 text-text shadow-[0_16px_48px_rgba(0,0,0,0.5)]
          outline-none transition duration-150 data-[starting-style]:scale-95 data-[starting-style]:opacity-0
          data-[ending-style]:scale-95 data-[ending-style]:opacity-0">
          <AlertDialog.Title className="text-sm font-semibold">{title}</AlertDialog.Title>
          <AlertDialog.Description className="mt-1 text-xs leading-relaxed text-text-dim">
            {description}
          </AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Close
              disabled={busy}
              className="flex h-8 items-center rounded-md px-3 text-xs text-text-dim transition
                hover:bg-surface-3 hover:text-text disabled:opacity-50"
            >
              {cancelLabel}
            </AlertDialog.Close>
            <button
              onClick={onConfirm}
              disabled={busy}
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
