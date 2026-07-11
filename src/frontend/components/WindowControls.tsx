import { type JSX } from 'react'
import clsx from 'clsx'

/** The window-control bridge the Electron preload exposes on `window`. */
interface YaacWindow {
  minimize: () => void
  toggleMaximize: () => void
  close: () => void
}

/** The bridge, or undefined in a browser / before the preload loads. */
export function windowApi(): YaacWindow | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { yaacWindow?: YaacWindow }).yaacWindow
}

const DOT = 'no-drag flex h-3 w-3 items-center justify-center rounded-full bg-text-faint/50 '
  + 'text-[8px] font-bold leading-none text-transparent transition-colors '
  + 'hover:bg-text-faint group-hover/wc:text-black/55'

/**
 * Custom monochrome window controls, drawn where the native macOS traffic
 * lights would be (main.ts hides them). Three gray dots — close / minimize /
 * zoom — that reveal their glyphs on hover, matching the macOS pattern. The row
 * is a drag handle; the buttons opt out with .no-drag.
 */
export function WindowControls({ className }: { className?: string }): JSX.Element {
  return (
    <div className={clsx('titlebar-drag group/wc flex w-full shrink-0 items-center justify-center gap-2', className)}>
      <button type="button" aria-label="Close window" title="Close" className={DOT} onClick={() => windowApi()?.close()}>
        ✕
      </button>
      <button
        type="button"
        aria-label="Minimize window"
        title="Minimize"
        className={DOT}
        onClick={() => windowApi()?.minimize()}
      >
        –
      </button>
      <button
        type="button"
        aria-label="Zoom window"
        title="Zoom"
        className={DOT}
        onClick={() => windowApi()?.toggleMaximize()}
      >
        +
      </button>
    </div>
  )
}
