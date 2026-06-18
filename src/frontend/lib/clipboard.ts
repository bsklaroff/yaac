/** A clipboard intent decoded from a terminal keydown. */
export type ClipboardAction = 'copy' | 'paste'

/** Just the keyboard-event fields the decision needs — keeps this pure and
 *  trivial to unit test without synthesizing a full KeyboardEvent. */
export type ClipboardKey = Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'key'>

/**
 * Map a terminal keydown to a copy/paste intent, following the platform
 * conventions terminal emulators use:
 *
 *  - macOS:  ⌘C / ⌘V (Cmd, no Ctrl) — Ctrl is left free for SIGINT etc.
 *  - else:   Ctrl+Shift+C / Ctrl+Shift+V — plain Ctrl+C stays SIGINT and
 *            plain Ctrl+V stays "quoted insert".
 *
 * Returns null for anything else, meaning "let the terminal handle it".
 */
export function clipboardKeyAction(e: ClipboardKey, isMac: boolean): ClipboardAction | null {
  const key = e.key.toLowerCase()
  if (key !== 'c' && key !== 'v') return null
  const macCombo = isMac && e.metaKey && !e.ctrlKey
  const otherCombo = !isMac && e.ctrlKey && e.shiftKey && !e.metaKey
  if (!macCombo && !otherCombo) return null
  return key === 'c' ? 'copy' : 'paste'
}
