import type { JSX } from 'react'
import { MoreIcon } from '#lib/icons'
import { YButton, type YButtonSize } from './YButton'
import { YMenu, YMenuItem, YMenuPopup } from './YMenu'
import { YTip, YTooltip } from './YTooltip'
import type { YIconGlyph } from './types'

/** An icon button's worth of action: its label is the tooltip, accessible
 *  name and menu row. `pressed` styles only the inline button, so a
 *  toggle's label should name what picking it does, which reads correctly
 *  as a menu row too. */
export interface YAction {
  label: string
  icon: YIconGlyph
  pressed?: boolean
  disabled?: boolean
  onClick: () => void
}

/**
 * A run of ghost icon buttons that folds into one ⋯ menu when the nearest
 * `@container` is under 22rem, so a toolbar in a narrow pane (a tile among
 * several) never draws over its neighbours. `side` is where the menu opens.
 */
export function YActions({ actions, size = 'md', side = 'bottom' }: {
  actions: YAction[]
  size?: YButtonSize
  side?: 'top' | 'bottom'
}): JSX.Element {
  return (
    <>
      <span className="flex shrink-0 items-center gap-1 @max-[22rem]:hidden">
        {actions.map((a) => <YActionButton key={a.label} size={size} {...a} />)}
      </span>
      <YMenu.Root>
        <YMenu.Trigger
          render={<YButton variant="ghost" size={size} icon={MoreIcon} aria-label="More actions" className="shrink-0 @min-[22rem]:hidden" />}
        />
        <YMenuPopup side={side} align={side === 'top' ? 'start' : 'end'} sideOffset={4}>
          {actions.map((a) => (
            <YMenuItem key={a.label} icon={a.icon} disabled={a.disabled} onClick={a.onClick}>{a.label}</YMenuItem>
          ))}
        </YMenuPopup>
      </YMenu.Root>
    </>
  )
}

/** One action as a ghost icon button with a tooltip. */
export function YActionButton({ label, icon, pressed, disabled, onClick, size = 'md' }: YAction & {
  size?: YButtonSize
}): JSX.Element {
  return (
    <YTooltip tip={<YTip title={label} />}>
      <YButton
        variant="ghost"
        size={size}
        icon={icon}
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        aria-pressed={pressed}
        className="aria-pressed:text-text"
      />
    </YTooltip>
  )
}
