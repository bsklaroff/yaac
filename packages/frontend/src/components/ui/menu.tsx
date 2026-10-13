import type { JSX } from 'react'
import clsx from 'clsx'
import { Menu } from '@base-ui/react/menu'
import { Popover } from '@base-ui/react/popover'

/** Class names shared by the dropdown menus and badge popovers. Callers add
 *  a width. */
export const POPUP = 'rounded-lg border border-border bg-surface-2 p-1 text-text '
  + 'shadow-[0_12px_32px_var(--shadow-color)] outline-none transition-opacity duration-100 '
  + 'data-[starting-style]:opacity-0 data-[ending-style]:opacity-0'

export const MENU_ITEM = 'flex w-full cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-xs '
  + 'text-text-dim outline-none data-[highlighted]:bg-surface-3 data-[highlighted]:text-text'

/** Where a popup sits against its trigger (or `anchor`). */
type Placement = Pick<Menu.Positioner.Props, 'side' | 'align' | 'sideOffset' | 'anchor'>

/** A menu's popup in the shared style: portaled to <body> and placed
 *  against its trigger. The rest of the props go to `Menu.Popup`. */
export function MenuPopup({ side, align, sideOffset, anchor, className, ...popup }: Placement
  & Omit<Menu.Popup.Props, 'className'> & { className?: string }): JSX.Element {
  return (
    <Menu.Portal>
      <Menu.Positioner side={side} align={align} sideOffset={sideOffset} anchor={anchor}>
        <Menu.Popup className={clsx(className, POPUP)} {...popup} />
      </Menu.Positioner>
    </Menu.Portal>
  )
}

/** A popover's popup in the shared style, as `MenuPopup` is for menus. */
export function PopoverPopup({ side, align, sideOffset, className, ...popup }: Omit<Placement, 'anchor'>
  & Omit<Popover.Popup.Props, 'className'> & { className?: string }): JSX.Element {
  return (
    <Popover.Portal>
      <Popover.Positioner side={side} align={align} sideOffset={sideOffset}>
        <Popover.Popup className={clsx(className, POPUP)} {...popup} />
      </Popover.Positioner>
    </Popover.Portal>
  )
}
