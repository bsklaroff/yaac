import type { JSX, ReactNode, RefObject } from 'react'
import clsx from 'clsx'
import { Dialog } from '@base-ui/react/dialog'
import { CloseIcon } from '#lib/icons'
import { useOpenerFocus } from '#lib/useOpenerFocus'

const VARIANT = {
  // A card the caller sizes; full-screen on small screens.
  card: [
    'left-1/2 top-1/2 max-h-[calc(100vh-4rem)] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2',
    'overflow-hidden rounded-xl border border-hairline bg-surface',
    'max-md:inset-0 max-md:left-0 max-md:top-0 max-md:h-full max-md:max-h-none max-md:w-full',
    'max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-none max-md:border-0',
  ],
  // The whole window but a margin, for master/detail overlays and editors;
  // full-screen on small screens.
  sheet: 'inset-4 flex flex-col gap-3 rounded-xl border border-hairline bg-surface p-4 '
    + 'max-md:inset-0 max-md:rounded-none max-md:border-0',
  // A small form the caller sizes, like a confirm dialog; a card on every
  // screen.
  form: 'left-1/2 top-1/2 max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg '
    + 'border border-border bg-surface-2 p-5',
}

/**
 * A modal over a dimmed backdrop, in one of three shapes (`VARIANT`).
 * Callers control `open`, usually from the UI store so any surface can open
 * it, and add size and layout in `className`.
 *
 * With a `title` it gets a header: the title, then `actions`, then a close
 * button (`closeLabel`, `closeIcon`).
 */
export function Modal({
  open,
  onOpenChange,
  variant = 'card',
  className,
  initialFocus,
  title,
  actions,
  closeLabel = 'Close',
  closeIcon = <CloseIcon size={14} />,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  variant?: keyof typeof VARIANT
  className?: string
  initialFocus?: RefObject<HTMLElement | null>
  title?: ReactNode
  actions?: ReactNode
  closeLabel?: string
  closeIcon?: ReactNode
  children: ReactNode
}): JSX.Element {
  const finalFocus = useOpenerFocus(open)
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/60 backdrop-blur-[1px] transition-opacity duration-150
          data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup
          {...(initialFocus !== undefined ? { initialFocus } : {})}
          finalFocus={finalFocus}
          className={clsx(
            'fixed text-text shadow-[0_16px_48px_var(--shadow-color)] outline-none transition duration-150',
            'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
            'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
            VARIANT[variant],
            className,
          )}
        >
          {title !== undefined && (
            <div className="flex flex-wrap items-center gap-2 md:flex-nowrap">
              <Dialog.Title className="mr-auto shrink-0 text-xs font-semibold text-text-dim max-md:text-sm">
                {title}
              </Dialog.Title>
              {actions}
              <Dialog.Close
                title={closeLabel}
                aria-label={closeLabel}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-faint transition
                  hover:bg-surface-2 hover:text-text max-md:h-9 max-md:w-9"
              >
                {closeIcon}
              </Dialog.Close>
            </div>
          )}
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
