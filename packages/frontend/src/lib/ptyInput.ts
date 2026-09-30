/**
 * A registry of mounted terminal panes that accept synthetic input.
 *
 * Phone keyboards lack Esc, Tab, Ctrl and arrow keys, so the mobile pane has
 * an extra key bar in WorkspaceView. The PTY socket belongs to
 * WorkspaceTerminal, so the bar sends keys through this registry instead of
 * a ref threaded through the layout. Senders use xterm's `input()`, the same
 * path a real keypress takes.
 */

const senders = new Map<string, (data: string) => void>()

/** The registry key for a pane, the same key WorkspaceView's keep-alive set
 *  uses. */
export function paneKey(workspaceId: string, target: string): string {
  return `${workspaceId}|${target}`
}

/** Register a pane's input sink; returns the deregistration function. */
export function registerPtyInput(key: string, send: (data: string) => void): () => void {
  senders.set(key, send)
  return () => {
    // A remount registers the new terminal before the old one's cleanup.
    if (senders.get(key) === send) senders.delete(key)
  }
}

/** Send `data` to a pane as if typed. False when no such pane is mounted. */
export function sendPtyInput(key: string, data: string): boolean {
  const send = senders.get(key)
  if (!send) return false
  send(data)
  return true
}

/** Byte sequences xterm emits for the keys a soft keyboard lacks. */
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
