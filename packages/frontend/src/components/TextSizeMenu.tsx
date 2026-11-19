import type { JSX } from 'react'
import { DEFAULT_FONT_SIZE, MAX_FONT_SIZE, MIN_FONT_SIZE } from '#lib/store'
import { IS_MAC } from '#lib/platform'
import { AddIcon, MinusIcon, TextSizeIcon } from '#lib/icons'
import { YButton, YPopover, YPopoverPopup } from '#ui'

/** A pane header's "Aa" button, opening − / size / + and Reset. */
export function TextSizeMenu({ size, onChange }: { size: number; onChange: (px: number) => void }): JSX.Element {
  const mod = IS_MAC ? '⌘' : 'Ctrl+'
  return (
    <YPopover.Root>
      <YPopover.Trigger
        render={<YButton variant="ghost" size="sm" icon={TextSizeIcon} title={`Text size (${mod}= / ${mod}−)`} aria-label="Text size" />}
      />
      <YPopoverPopup side="bottom" align="end" sideOffset={6} className="flex items-center gap-1 text-md">
        <YButton
          variant="ghost"
          size="sm"
          icon={MinusIcon}
          onClick={() => onChange(size - 1)}
          disabled={size <= MIN_FONT_SIZE}
          title={`Smaller (${mod}−)`}
          aria-label="Smaller text"
        />
        <span className="w-10 text-center tabular-nums">{size}px</span>
        <YButton
          variant="ghost"
          size="sm"
          icon={AddIcon}
          onClick={() => onChange(size + 1)}
          disabled={size >= MAX_FONT_SIZE}
          title={`Larger (${mod}=)`}
          aria-label="Larger text"
        />
        <YButton
          variant="ghost"
          size="sm"
          onClick={() => onChange(DEFAULT_FONT_SIZE)}
          disabled={size === DEFAULT_FONT_SIZE}
          title={`Reset (${mod}0)`}
        >
          Reset
        </YButton>
      </YPopoverPopup>
    </YPopover.Root>
  )
}
