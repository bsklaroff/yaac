import type { JSX, ReactElement, ReactNode } from 'react'
import { Tooltip } from '@base-ui/react/tooltip'
import { YKbd } from './YKbd'

/** A tooltip's body: what the control does, why, and its key. */
export function YTip({ title, hint, keys }: { title: string; hint?: string; keys?: string }): JSX.Element {
  return (
    <>
      <span className="text-text">{title}</span>
      {keys && <YKbd className="ml-2">{keys}</YKbd>}
      {hint && <span className="block text-muted">{hint}</span>}
    </>
  )
}

/** A styled hover tooltip, faster and more legible than `title`. Siblings
 *  under one `Tooltip.Provider` open instantly once one is showing. */
export function YTooltip({ tip, side = 'bottom', children }: {
  tip: ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  children: ReactElement
}): JSX.Element {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger delay={400} render={children} />
      <Tooltip.Portal>
        <Tooltip.Positioner side={side} sideOffset={6}>
          <Tooltip.Popup
            className="z-50 max-w-[260px] rounded-md bg-raised px-2 py-1 text-sm
              shadow-raised transition-opacity duration-100
              data-[starting-style]:opacity-0 data-[ending-style]:opacity-0"
          >
            {tip}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

/** Groups tooltips so that once one is showing, its neighbours open at once. */
export const YTooltipProvider = Tooltip.Provider
