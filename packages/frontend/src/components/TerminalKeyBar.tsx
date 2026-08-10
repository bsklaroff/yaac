import type { JSX } from 'react'
import { PTY_KEYS, paneKey, sendPtyInput } from '#lib/ptyInput'

/** The keys a phone keyboard doesn't have, in the order a TUI needs them:
 *  dismiss, complete, interrupt, then navigate. Labels stay ASCII apart from
 *  the arrows — neither the UI sans nor the terminal mono stack carries ⇧
 *  (U+21E7), which renders as tofu. */
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
 * Accessory keys for a terminal pane on a phone.
 *
 * A soft keyboard has no Esc, Tab, Ctrl or arrows, and every agent TUI is
 * driven with all four — so without this a `tui` worktree is readable on a
 * phone but not usable. (An `acp` worktree needs none of it: its pane is a
 * chat composer, see docs/agent-modes.md.)
 *
 * The bar is a sibling of the measured workspace rather than an overlay, so
 * the space it takes comes out of the terminal's height and the PTY's row
 * count follows — nothing ends up hidden behind it.
 *
 * `onPointerDown`+`preventDefault` rather than `onClick`: a tap that moves
 * focus out of xterm's hidden textarea would dismiss the soft keyboard, and
 * the whole point is to press these *while* typing.
 */
export function TerminalKeyBar({
  worktreeId,
  target,
}: {
  worktreeId: string
  /** The visible terminal pane's /pty/attach target. */
  target: string
}): JSX.Element {
  const key = paneKey(worktreeId, target)
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
