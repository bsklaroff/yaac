import { useRef, type JSX } from 'react'
import clsx from 'clsx'
import { Menu } from '@base-ui/react/menu'
import { MoreIcon } from '#lib/icons'
import { MENU_ITEM, POPUP } from '#components/ui/menu'
import { useReadOnly } from '#lib/viewer'

/** A menu item, or a separator. `view` marks an item that changes only what
 *  this client shows, so it stays in a read-only view (#lib/viewer). */
export type RowMenuItem = { label: string; onSelect: () => void; view?: true } | 'separator'

/**
 * A row's `…` actions menu at its top right, shown on hover (always on
 * touch).
 *
 * A picked item runs after the menu finishes closing, and focus stays where
 * the item put it (a rename input, or a dialog). Before the item runs,
 * focus is on the trigger after a keyboard pick, so a dialog returns there,
 * and on nothing after a pointer pick, so the hover-only `…` isn't left
 * showing.
 */
export function RowMenu({ label, items, position = 'right-2 top-2' }: {
  label: string
  items: RowMenuItem[]
  /** The trigger's position; a group header is shorter than a row. */
  position?: string
}): JSX.Element | null {
  const trigger = useRef<HTMLButtonElement>(null)
  // Kept until the next open, since `finalFocus` reads it after the item runs.
  const picked = useRef<(() => void) | null>(null)
  // Whether the last input in the popup was a key. The click's `detail` can't
  // tell, since a press-drag-release pick clicks programmatically.
  const byKey = useRef(false)
  const readOnly = useReadOnly()
  const shown = readOnly ? items.filter((item) => item !== 'separator' && item.view) : items
  if (shown.length === 0) return null
  return (
    <Menu.Root
      onOpenChange={(open) => { if (open) picked.current = null }}
      onOpenChangeComplete={(open) => {
        if (open || picked.current === null) return
        if (byKey.current) trigger.current?.focus()
        else if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
        picked.current()
      }}
    >
      <Menu.Trigger
        ref={trigger}
        title={label}
        aria-label={label}
        className={clsx(position, `absolute flex h-5 w-5 items-center justify-center rounded text-text-faint
          opacity-0 transition hover:bg-surface-3 hover:text-text pointer-events-none
          group-hover:pointer-events-auto group-hover:opacity-100
          focus-visible:pointer-events-auto focus-visible:opacity-100
          data-[popup-open]:pointer-events-auto data-[popup-open]:opacity-100 data-[popup-open]:bg-surface-3
          max-md:h-7 max-md:w-7 max-md:pointer-events-auto max-md:opacity-100`)}
      >
        <MoreIcon size={14} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4}>
          <Menu.Popup
            finalFocus={() => picked.current === null}
            onKeyDown={() => { byKey.current = true }}
            onPointerUp={() => { byKey.current = false }}
            className={clsx('min-w-[180px]', POPUP)}
          >
            {shown.map((item, i) => item === 'separator'
              ? <Menu.Separator key={`sep-${i}`} className="my-1 h-px bg-border" />
              : (
                <Menu.Item key={item.label} className={MENU_ITEM} onClick={() => { picked.current = item.onSelect }}>
                  {item.label}
                </Menu.Item>
              ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
