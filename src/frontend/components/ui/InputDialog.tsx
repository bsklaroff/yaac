import { useEffect, useRef, useState, type JSX } from 'react'
import { Dialog } from '@base-ui/react/dialog'

/**
 * Small single-field prompt dialog (Base UI Dialog + design tokens).
 * Controlled via `open`/`onOpenChange`; submits on Enter or the confirm
 * button. The field resets to `initialValue` each time it opens.
 */
export function InputDialog({
  open,
  onOpenChange,
  title,
  placeholder,
  initialValue = '',
  confirmLabel = 'Save',
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  placeholder?: string
  initialValue?: string
  confirmLabel?: string
  onSubmit: (value: string) => void
}): JSX.Element {
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setValue(initialValue)
      // Focus after the open transition mounts the input.
      setTimeout(() => inputRef.current?.select(), 50)
    }
  }, [open, initialValue])

  const submit = (): void => {
    onSubmit(value)
    onOpenChange(false)
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/60 backdrop-blur-[1px] transition-opacity duration-150
          data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 w-[400px] max-w-[calc(100vw-2rem)] -translate-x-1/2
          -translate-y-1/2 rounded-lg border border-hairline bg-surface-2 p-5 text-text
          shadow-[0_16px_48px_var(--shadow-color)] outline-none transition duration-150
          data-[starting-style]:scale-95 data-[starting-style]:opacity-0
          data-[ending-style]:scale-95 data-[ending-style]:opacity-0">
          <Dialog.Title className="text-sm font-semibold">{title}</Dialog.Title>
          <form
            onSubmit={(e) => { e.preventDefault(); submit() }}
            className="mt-3 flex flex-col gap-4"
          >
            <input
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={placeholder}
              className="w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-sm text-text
                outline-none focus:border-border-strong"
            />
            <div className="flex justify-end gap-2">
              <Dialog.Close className="flex h-8 items-center rounded-md px-3 text-xs text-text-dim transition
                hover:bg-surface-3 hover:text-text">
                Cancel
              </Dialog.Close>
              <button
                type="submit"
                className="flex h-8 items-center rounded-md bg-accent px-3 text-xs font-medium text-bg transition
                  hover:brightness-110"
              >
                {confirmLabel}
              </button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
