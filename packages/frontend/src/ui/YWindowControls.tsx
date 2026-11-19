import type { JSX } from 'react'
import { cn } from './cn'
import { hidesTitleBar, windowApi } from '#lib/platform'

const DOT = 'no-drag flex h-3 w-3 items-center justify-center rounded-full bg-subtle/45 '
  + 'text-xs font-bold leading-none text-black/0 transition-colors group-hover/wc:text-black/60'

/**
 * Custom close / minimize / zoom dots in place of the macOS traffic lights,
 * which the desktop shell hides there. Monochrome until hovered. The row is a
 * drag handle; the buttons opt out with .no-drag. Drawn only in the macOS
 * desktop app's own window: on other platforms the shell keeps the native
 * frame, and a preview pane is an Electron view too but has no bridge to a
 * window it could close.
 */
export function YWindowControls({ className }: { className?: string }): JSX.Element | null {
  if (!hidesTitleBar() || windowApi()?.close === undefined) return null
  return (
    <div className={cn('titlebar-drag group/wc flex shrink-0 items-center gap-2', className)}>
      <button
        type="button"
        aria-label="Close window"
        title="Close"
        className={cn(DOT, 'group-hover/wc:bg-[#ff5f57]')}
        onClick={() => windowApi()?.close?.()}
      >
        ✕
      </button>
      <button
        type="button"
        aria-label="Minimize window"
        title="Minimize"
        className={cn(DOT, 'group-hover/wc:bg-[#febc2e]')}
        onClick={() => windowApi()?.minimize?.()}
      >
        –
      </button>
      <button
        type="button"
        aria-label="Zoom window"
        title="Full screen (⌥ to zoom)"
        className={cn(DOT, 'group-hover/wc:bg-[#28c840]')}
        onClick={(e) => windowApi()?.toggleMaximize?.(e.altKey)}
      >
        +
      </button>
    </div>
  )
}
