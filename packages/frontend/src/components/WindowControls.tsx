import type { JSX } from 'react'
import clsx from 'clsx'

/** The window-control bridge the Electron preload exposes on `window`. */
interface YaacWindow {
  minimize: () => void
  /** altKey selects the macOS Option-click zoom (maximize) instead of full screen. */
  toggleMaximize: (altKey?: boolean) => void
  close: () => void
  openExternal: (url: string) => void
}

/** The bridge, or undefined in a browser / before the preload loads. */
export function windowApi(): YaacWindow | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { yaacWindow?: YaacWindow }).yaacWindow
}

const DOT = 'no-drag flex h-3 w-3 items-center justify-center rounded-full bg-text-faint/45 '
  + 'text-[8px] font-bold leading-none text-black/0 transition-colors group-hover/wc:text-black/60'

/**
 * Custom window controls, drawn where the native macOS traffic lights would be
 * (the desktop main process hides them). Three dots — close / minimize / zoom
 * — monochrome at rest; hovering the row lights them up in the familiar
 * red/amber/green and reveals their glyphs, like the real thing. The row is a
 * drag handle; the buttons opt out with .no-drag.
 */
export function WindowControls({ className }: { className?: string }): JSX.Element {
  return (
    <div className={clsx('titlebar-drag group/wc flex w-full shrink-0 items-center justify-center gap-2', className)}>
      <button
        type="button"
        aria-label="Close window"
        title="Close"
        className={clsx(DOT, 'group-hover/wc:bg-[#ff5f57]')}
        onClick={() => windowApi()?.close()}
      >
        ✕
      </button>
      <button
        type="button"
        aria-label="Minimize window"
        title="Minimize"
        className={clsx(DOT, 'group-hover/wc:bg-[#febc2e]')}
        onClick={() => windowApi()?.minimize()}
      >
        –
      </button>
      <button
        type="button"
        aria-label="Zoom window"
        title="Full screen (⌥ to zoom)"
        className={clsx(DOT, 'group-hover/wc:bg-[#28c840]')}
        onClick={(e) => windowApi()?.toggleMaximize(e.altKey)}
      >
        +
      </button>
    </div>
  )
}
