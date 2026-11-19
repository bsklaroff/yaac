import type { JSX, ReactNode } from 'react'
import { cn } from './cn'
import { Menu } from '@base-ui/react/menu'
import { Popover } from '@base-ui/react/popover'
import { CheckIcon } from '#lib/icons'
import type { YIconGlyph } from './types'

/*
 * Menus and popovers in the app's style. The base-ui namespaces are
 * re-exported (`YMenu.Root`, `YMenu.Trigger`, `YPopover.Root`, …) so a
 * screen builds a menu from these parts and never styles one itself:
 * `YMenuPopup` / `YPopoverPopup` for the floating box, `YMenuItem` and its
 * radio and checkbox kinds for rows, `YMenuSeparator` and `YMenuLabel`.
 */
export { Menu as YMenu } from '@base-ui/react/menu'
export { Popover as YPopover } from '@base-ui/react/popover'
export { ContextMenu as YContextMenu } from '@base-ui/react/context-menu'

/** The floating box every menu and popover draws in. Callers add a width. */
export const POPUP = 'rounded-md bg-raised p-1 text-text shadow-raised outline-none transition-opacity duration-100 '
  + 'data-[starting-style]:opacity-0 data-[ending-style]:opacity-0'

/** A menu row. Exported for context menus, whose items are their own
 *  base-ui part. */
export const MENU_ITEM = 'flex min-h-7 w-full cursor-default select-none items-center gap-2 rounded-xs px-2.5 py-1 '
  + 'text-md text-muted outline-none data-[highlighted]:bg-hover data-[highlighted]:text-text '
  + 'data-[disabled]:pointer-events-none data-[disabled]:opacity-50'

/** Where a popup sits against its trigger (or `anchor`). */
type Placement = Pick<Menu.Positioner.Props, 'side' | 'align' | 'sideOffset' | 'anchor'>

/** A menu's popup: portaled to <body> and placed against its trigger. The
 *  rest of the props go to `Menu.Popup`. */
export function YMenuPopup({ side, align, sideOffset = 4, anchor, className, ...popup }: Placement
  & Omit<Menu.Popup.Props, 'className'> & { className?: string }): JSX.Element {
  return (
    <Menu.Portal>
      <Menu.Positioner side={side} align={align} sideOffset={sideOffset} anchor={anchor}>
        <Menu.Popup className={cn(POPUP, className)} {...popup} />
      </Menu.Positioner>
    </Menu.Portal>
  )
}

/** A popover's popup, as `YMenuPopup` is for menus. */
export function YPopoverPopup({ side, align, sideOffset = 4, className, ...popup }: Omit<Placement, 'anchor'>
  & Omit<Popover.Popup.Props, 'className'> & { className?: string }): JSX.Element {
  return (
    <Popover.Portal>
      <Popover.Positioner side={side} align={align} sideOffset={sideOffset}>
        <Popover.Popup className={cn(POPUP, className)} {...popup} />
      </Popover.Positioner>
    </Popover.Portal>
  )
}

interface RowProps {
  icon?: YIconGlyph
  /** The shortcut, right-aligned. */
  kbd?: string
  danger?: boolean
  className?: string
  children?: ReactNode
}

function RowContent({ icon: IconGlyph, kbd, children }: Omit<RowProps, 'danger' | 'className'>): JSX.Element {
  return (
    <>
      {IconGlyph && <IconGlyph size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />}
      {children}
      {kbd && <span className="ml-auto pl-4 font-mono text-xs text-subtle">{kbd}</span>}
    </>
  )
}

/** A menu row: an optional icon, the label, an optional shortcut. */
export function YMenuItem({ icon, kbd, danger = false, className, children, ...item }: RowProps
  & Omit<Menu.Item.Props, 'className' | 'children'>): JSX.Element {
  return (
    <Menu.Item className={cn(MENU_ITEM, danger && 'text-danger data-[highlighted]:text-danger', className)} {...item}>
      <RowContent icon={icon} kbd={kbd}>{children}</RowContent>
    </Menu.Item>
  )
}

/** A row in a `YMenu.RadioGroup`, ticked when chosen. */
export function YMenuRadioItem({ icon, kbd, className, children, ...item }: Omit<RowProps, 'danger'>
  & Omit<Menu.RadioItem.Props, 'className' | 'children'>): JSX.Element {
  return (
    <Menu.RadioItem className={cn(MENU_ITEM, 'pl-7 relative', className)} {...item}>
      <Menu.RadioItemIndicator className="absolute left-2 flex">
        <CheckIcon size={13} strokeWidth={2} aria-hidden />
      </Menu.RadioItemIndicator>
      <RowContent icon={icon} kbd={kbd}>{children}</RowContent>
    </Menu.RadioItem>
  )
}

/** A row that toggles, ticked while on. */
export function YMenuCheckboxItem({ icon, kbd, className, children, ...item }: Omit<RowProps, 'danger'>
  & Omit<Menu.CheckboxItem.Props, 'className' | 'children'>): JSX.Element {
  return (
    <Menu.CheckboxItem className={cn(MENU_ITEM, 'pl-7 relative', className)} {...item}>
      <Menu.CheckboxItemIndicator className="absolute left-2 flex">
        <CheckIcon size={13} strokeWidth={2} aria-hidden />
      </Menu.CheckboxItemIndicator>
      <RowContent icon={icon} kbd={kbd}>{children}</RowContent>
    </Menu.CheckboxItem>
  )
}

export function YMenuSeparator({ className }: { className?: string }): JSX.Element {
  return <Menu.Separator className={cn('mx-2 my-1 h-px bg-line', className)} />
}

/** A small heading over a group of rows. */
export function YMenuLabel({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  return <div className={cn('px-2.5 pb-1 pt-1.5 text-sm text-subtle', className)}>{children}</div>
}
