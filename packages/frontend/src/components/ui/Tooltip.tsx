import type { JSX, ReactElement, ReactNode } from 'react'
import { Tooltip } from '@base-ui/react/tooltip'

/** A tooltip's body: what the control does, why, and its key. */
export function Tip({ title, hint, keys }: { title: string; hint?: string; keys?: string }): JSX.Element {
  return (
    <>
      <span className="text-text">{title}</span>
      {keys && <kbd className="ml-2 font-sans text-text-faint">{keys}</kbd>}
      {hint && <span className="block text-text-dim">{hint}</span>}
    </>
  )
}

/** A styled hover tooltip — quicker and more legible than `title`. Siblings
 *  under one `Tooltip.Provider` open instantly once one of them is showing. */
export function WithTip({ tip, children }: { tip: ReactNode; children: ReactElement }): JSX.Element {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger delay={400} render={children} />
      <Tooltip.Portal>
        <Tooltip.Positioner side="bottom" sideOffset={6}>
          <Tooltip.Popup
            className="z-50 max-w-[240px] rounded-md border border-border bg-surface-2 px-2 py-1 text-[11px] leading-snug
              shadow-[0_8px_24px_var(--shadow-color)] transition-opacity duration-100
              data-[starting-style]:opacity-0 data-[ending-style]:opacity-0"
          >
            {tip}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}
