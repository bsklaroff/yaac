import type { JSX } from 'react'
import clsx from 'clsx'
import { Popover } from '@base-ui/react/popover'
import { PopoverPopup } from '#components/ui/menu'
import { DEFAULT_FONT_SIZE, MAX_FONT_SIZE, MIN_FONT_SIZE } from '#lib/store'
import { IS_MAC } from '#lib/platform'
import { AddIcon, MinusIcon, TextSizeIcon } from '#lib/icons'

/** A pane header's "Aa" button, opening − / size / + and Reset. `className`
 *  sizes the trigger to the header it sits in. */
export function TextSizeMenu({ size, onChange, className }: {
  size: number
  onChange: (px: number) => void
  className: string
}): JSX.Element {
  const mod = IS_MAC ? '⌘' : 'Ctrl+'
  const step = 'flex h-6 w-6 items-center justify-center rounded text-text-dim transition hover:bg-surface-3 '
    + 'hover:text-text disabled:pointer-events-none disabled:opacity-35'
  return (
    <Popover.Root>
      <Popover.Trigger
        title={`Text size (${mod}= / ${mod}−)`}
        aria-label="Text size"
        className={clsx('flex shrink-0 items-center justify-center rounded text-text-faint outline-none transition',
          'hover:bg-surface-2 hover:text-text data-[popup-open]:bg-surface-2 data-[popup-open]:text-text', className)}
      >
        <TextSizeIcon size={14} />
      </Popover.Trigger>
      <PopoverPopup side="bottom" align="end" sideOffset={6} className="flex items-center gap-1 text-xs">
        <button
          onClick={() => onChange(size - 1)}
          disabled={size <= MIN_FONT_SIZE}
          title={`Smaller (${mod}−)`}
          aria-label="Smaller text"
          className={step}
        >
          <MinusIcon size={13} />
        </button>
        <span className="w-10 text-center tabular-nums">{size}px</span>
        <button
          onClick={() => onChange(size + 1)}
          disabled={size >= MAX_FONT_SIZE}
          title={`Larger (${mod}=)`}
          aria-label="Larger text"
          className={step}
        >
          <AddIcon size={13} />
        </button>
        <button
          onClick={() => onChange(DEFAULT_FONT_SIZE)}
          disabled={size === DEFAULT_FONT_SIZE}
          title={`Reset (${mod}0)`}
          className="h-6 rounded px-2 text-text-dim transition hover:bg-surface-3 hover:text-text
            disabled:pointer-events-none disabled:opacity-35"
        >
          Reset
        </button>
      </PopoverPopup>
    </Popover.Root>
  )
}
