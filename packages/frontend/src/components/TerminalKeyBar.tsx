import type { JSX } from 'react'
import { PTY_KEYS, paneKey, sendPtyInput } from '#lib/ptyInput'

/** Keys a phone keyboard lacks: dismiss, complete, interrupt, navigate.
 *  Labels are ASCII apart from the arrows; our fonts have no ⇧ glyph. */
const KEYS: { label: string; data: string; aria: string; wide?: boolean }[] = [
  { label: 'esc', data: PTY_KEYS.escape, aria: 'Escape', wide: true },
  { label: 'tab', data: PTY_KEYS.tab, aria: 'Tab', wide: true },
  { label: 'S-tab', data: PTY_KEYS.shiftTab, aria: 'Shift Tab', wide: true },
  { label: '^C', data: PTY_KEYS.ctrlC, aria: 'Control C', wide: true },
  { label: '←', data: PTY_KEYS.left, aria: 'Left arrow' },
  { label: '↓', data: PTY_KEYS.down, aria: 'Down arrow' },
  { label: '↑', data: PTY_KEYS.up, aria: 'Up arrow' },
  { label: '→', data: PTY_KEYS.right, aria: 'Right arrow' },
]

/**
 * Esc, Tab, Ctrl and arrow keys for a `tui` terminal pane on a phone, whose
 * soft keyboard has none of them.
 *
 * The bar sits beside the terminal rather than over it, so the terminal's
 * rows shrink to fit. Keys fire on pointerdown with `preventDefault` so the
 * tap does not move focus out of xterm and close the soft keyboard.
 */
export function TerminalKeyBar({
  workspaceId,
  target,
}: {
  workspaceId: string
  /** The visible terminal pane's /pty/attach target. */
  target: string
}): JSX.Element {
  const key = paneKey(workspaceId, target)
  return (
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto px-1 py-1">
      {KEYS.map((k) => (
        <button
          key={k.label}
          aria-label={k.aria}
          onPointerDown={(e) => {
            e.preventDefault()
            sendPtyInput(key, k.data)
          }}
          className={`flex h-9 shrink-0 items-center justify-center rounded-md border border-hairline
            bg-surface-2 font-mono text-xs text-text-dim transition active:bg-surface-3 active:text-text
            ${k.wide ? 'min-w-11 px-2.5' : 'w-11'}`}
        >
          {k.label}
        </button>
      ))}
    </div>
  )
}
