import type { JSX, ReactNode, RefObject } from 'react'
import clsx from 'clsx'
import { Dialog } from '@base-ui/react/dialog'
import { useOpenerFocus } from '#lib/useOpenerFocus'

/**
 * A centered modal card over a dimmed backdrop, full-screen on small screens.
 * Callers pass size and layout in `className` and control `open`, usually
 * from the UI store so any surface can open it.
 */
export function Modal({
  open,
  onOpenChange,
  className,
  initialFocus,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Size and layout for the card, e.g. `h-[480px] w-[720px] flex`. */
  className?: string
  initialFocus?: RefObject<HTMLElement | null>
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
            'fixed left-1/2 top-1/2 max-h-[calc(100vh-4rem)] max-w-[calc(100vw-2rem)] -translate-x-1/2',
            '-translate-y-1/2 overflow-hidden rounded-xl border border-hairline bg-surface text-text',
            'shadow-[0_16px_48px_var(--shadow-color)] outline-none transition duration-150',
            'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
            'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
            className,
            'max-md:inset-0 max-md:left-0 max-md:top-0 max-md:h-full max-md:max-h-none max-md:w-full',
            'max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-none max-md:border-0',
          )}
        >
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
