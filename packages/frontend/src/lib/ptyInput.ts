/**
 * A registry of live terminal panes that can accept synthetic input.
 *
 * A phone keyboard has no Esc, Tab, Ctrl or arrow keys, and every agent TUI
 * needs all four — so the mobile pane grows an accessory key bar. That bar
 * lives in WorktreeView's chrome, while the PTY socket is private to the
 * WorktreeTerminal that owns it, so the two meet here rather than by threading
 * a ref down through the pane layout.
 *
 * The registered sender routes through xterm's own `input()`, which is the
 * same path a real keypress takes (onData → the attach socket) — so a
 * bar-pressed Esc is indistinguishable from a typed one, including while the
 * socket is down.
 */

const senders = new Map<string, (data: string) => void>()

/** The registry key for a pane: the same worktree|target pair WorktreeView
 *  uses for its keep-alive set. */
export function paneKey(worktreeId: string, target: string): string {
  return `${worktreeId}|${target}`
}

/** Register a pane's input sink; returns the deregistration function. */
export function registerPtyInput(key: string, send: (data: string) => void): () => void {
  senders.set(key, send)
  return () => {
    // Only if we're still the current owner: a remount registers the new
    // terminal before the old one's cleanup runs.
    if (senders.get(key) === send) senders.delete(key)
  }
}

/** Feed `data` to a pane as if it had been typed. False when no such pane is
 *  mounted (a stale key, or a pane torn down mid-press). */
export function sendPtyInput(key: string, data: string): boolean {
  const send = senders.get(key)
  if (!send) return false
  send(data)
  return true
}

/** Byte sequences for the keys a soft keyboard doesn't have. Values are what
 *  xterm itself emits for those presses, so a TUI can't tell the difference. */
export const PTY_KEYS = {
  escape: '\x1b',
  tab: '\t',
  shiftTab: '\x1b[Z',
  ctrlC: '\x03',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
} as const
