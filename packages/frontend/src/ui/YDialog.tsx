import type { JSX, ReactNode, RefObject } from 'react'
import { cn } from './cn'
import { Dialog } from '@base-ui/react/dialog'
import { CloseIcon } from '#lib/icons'
import { useOpenerFocus } from '#lib/useOpenerFocus'
import { yButtonClass } from './YButton'

/*
 * The popups are portaled to <body>, outside the shell's notch clearance
 * (`safe-area-inset`, index.css), so the large variants clear the notch and
 * home indicator themselves: full-screen ones by the same transparent border,
 * and the desktop shapes, which a notched phone gets in landscape, by widening
 * their margins.
 */
const SHEET = [
  'inset-[max(1rem,env(safe-area-inset-top))_max(1rem,env(safe-area-inset-right))_max(1rem,env(safe-area-inset-bottom))_max(1rem,env(safe-area-inset-left))]',
  'flex bg-surface shadow-raised',
  'max-md:inset-0 max-md:rounded-none max-md:safe-area-inset',
]

const VARIANT = {
  // A card the caller sizes; full-screen on small screens.
  card: [
    'left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2',
    'max-h-[calc(100vh-4rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))]',
    'max-w-[calc(100vw-2rem-env(safe-area-inset-left)-env(safe-area-inset-right))]',
    'overflow-hidden bg-surface shadow-raised',
    'max-md:inset-0 max-md:left-0 max-md:top-0 max-md:h-full max-md:max-h-none max-md:w-full',
    'max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-none max-md:safe-area-inset',
  ],
  // The whole window but a margin, for master/detail overlays and editors;
  // full-screen on small screens.
  sheet: [SHEET, 'flex-col gap-3 p-4'],
  // The sheet's shape left unpadded, for a nav beside a content pane
  // (settings).
  split: [SHEET, 'overflow-hidden'],
  // A small form the caller sizes, like a confirm dialog; a card on every
  // screen.
  form: 'left-1/2 top-1/2 max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 '
    + 'bg-raised p-5 shadow-raised',
}

/**
 * A modal over a dimmed backdrop, in one of four shapes (`VARIANT`).
 * Callers control `open`, usually from the UI store so any surface can open
 * it, and add size and layout in `className`.
 *
 * With a `title` it gets a header: the title, then `actions`, then a close
 * button (`closeLabel`, `closeIcon`).
 */
export function YDialog({
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
        <Dialog.Backdrop className="no-drag fixed inset-0 bg-overlay transition-opacity duration-150
          data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup
          {...(initialFocus !== undefined ? { initialFocus } : {})}
          finalFocus={finalFocus}
          className={cn(
            'fixed text-text outline-none transition duration-150',
            'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
            'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
            VARIANT[variant],
            className,
          )}
        >
          {title !== undefined && (
            <div className="flex flex-wrap items-center gap-2 md:flex-nowrap">
              <Dialog.Title className="mr-auto shrink-0 text-base font-semibold text-text">
                {title}
              </Dialog.Title>
              {actions}
              <Dialog.Close
                title={closeLabel}
                aria-label={closeLabel}
                className={cn(yButtonClass('ghost', 'md', true), 'max-md:h-9 max-md:w-9')}
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

/* Parts for a dialog's own body: its title and description (for screen
 * readers), and a close control (render a YButton through it). */
export const YDialogTitle = Dialog.Title
export const YDialogDescription = Dialog.Description
export const YDialogClose = Dialog.Close
