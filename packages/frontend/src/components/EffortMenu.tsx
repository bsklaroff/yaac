import type { JSX } from 'react'
import clsx from 'clsx'
import { Menu } from '@base-ui/react/menu'
import { MENU_ITEM, POPUP } from '#components/ui/menu'
import { CheckIcon, ChevronIcon } from '#lib/icons'
import { effortLabel } from '@yaac/shared/types'

/**
 * The chat composer's effort level (docs/effort-levels.md): a label showing
 * the level the conversation is at, which opens a menu of the levels its
 * current model offers. The levels and their names are the agent's own, so
 * they follow a model switch.
 */

const TRIGGER = 'flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-text-faint outline-none '
  + 'hover:bg-surface-2 hover:text-text disabled:opacity-40 data-[popup-open]:bg-surface-2 '
  + 'data-[popup-open]:text-text'

export function EffortMenu({
  current,
  available,
  disabled,
  onSelect,
}: {
  current: string
  available: ReadonlyArray<{ value: string; name: string }>
  disabled: boolean
  onSelect: (effort: string) => void
}): JSX.Element {
  const label = available.find((o) => o.value === current)?.name ?? effortLabel(current)
  return (
    <Menu.Root>
      <Menu.Trigger aria-label="Effort" title="How hard the model thinks" disabled={disabled} className={TRIGGER}>
        {label} effort
        <ChevronIcon size={11} className="-rotate-90" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="start" sideOffset={6}>
          <Menu.Popup className={clsx('w-[180px]', POPUP)}>
            <Menu.RadioGroup value={current} onValueChange={(effort: string) => onSelect(effort)}>
              {available.map((o) => (
                <Menu.RadioItem key={o.value} value={o.value} closeOnClick className={MENU_ITEM}>
                  <span className="w-3 shrink-0">
                    <Menu.RadioItemIndicator><CheckIcon size={12} /></Menu.RadioItemIndicator>
                  </span>
                  <span className="text-text">{o.name}</span>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
