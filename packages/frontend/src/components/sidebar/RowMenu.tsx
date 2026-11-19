import { useRef, type JSX } from 'react'
import clsx from 'clsx'
import { MoreIcon } from '#lib/icons'
import { useReadOnly } from '#lib/viewer'
import { YButton, YMenu, YMenuItem, YMenuPopup, YMenuSeparator } from '#ui'

/** A menu item, or a separator. `view` marks an item that changes only what
 *  this client shows, so it stays in a read-only view (#lib/viewer). */
export type RowMenuItem = { label: string; onSelect: () => void; view?: true } | 'separator'

/**
 * A row's `…` actions menu. In a `SidebarRow` it sits with the row's other
 * hover actions; a section heading passes `hoverOnly` to hide it until the
 * heading (a `group/row`) is hovered; on touch it always shows.
 *
 * A picked item runs after the menu finishes closing, and focus stays where
 * the item put it (a rename input, or a dialog). Before the item runs,
 * focus is on the trigger after a keyboard pick, so a dialog returns there,
 * and on nothing after a pointer pick, so the hover-only `…` isn't left
 * showing.
 */
export function RowMenu({ label, items, hoverOnly = false, onOpenChange }: {
  label: string
  items: RowMenuItem[]
  hoverOnly?: boolean
  /** Told when the menu opens and closes, so a row can keep it shown. */
  onOpenChange?: (open: boolean) => void
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
    <YMenu.Root
      onOpenChange={(open) => {
        if (open) picked.current = null
        onOpenChange?.(open)
      }}
      onOpenChangeComplete={(open) => {
        if (open || picked.current === null) return
        if (byKey.current) trigger.current?.focus()
        else if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
        picked.current()
      }}
    >
      <YMenu.Trigger
        ref={trigger}
        render={(
          <YButton
            variant="ghost"
            size="sm"
            icon={MoreIcon}
            title={label}
            aria-label={label}
            className={clsx('max-md:size-7', hoverOnly && `opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100
              data-[popup-open]:opacity-100 max-md:opacity-100`)}
          />
        )}
      />
      <YMenuPopup
        side="bottom"
        align="end"
        sideOffset={4}
        finalFocus={() => picked.current === null}
        onKeyDown={() => { byKey.current = true }}
        onPointerUp={() => { byKey.current = false }}
        className="min-w-[180px]"
      >
        {shown.map((item, i) => item === 'separator'
          ? <YMenuSeparator key={`sep-${i}`} />
          : (
            <YMenuItem key={item.label} onClick={() => { picked.current = item.onSelect }}>
              {item.label}
            </YMenuItem>
          ))}
      </YMenuPopup>
    </YMenu.Root>
  )
}
