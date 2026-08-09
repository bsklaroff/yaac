/**
 * Exponential-backoff reconnect policy shared by the server's two browser
 * WebSockets — the `/events` stream (useEvents) and the `/pty/attach` terminal
 * (WorktreeTerminal): start at 500ms and double on each failed attempt up to a
 * 10s ceiling, resetting to the initial delay once a socket opens.
 */
export const INITIAL_RECONNECT_DELAY_MS = 500
export const MAX_RECONNECT_DELAY_MS = 10_000

/**
 * How long a terminal drop must persist before it is announced on screen
 * (WorktreeTerminal). Most drops are a shared-transport recycle server-side:
 * every terminal re-attaches within a second and tmux repaints the whole
 * screen, so a notice for one of those is pure noise. Must outlast the
 * first reconnect attempt — the initial delay plus an attach — or it would
 * announce drops that have already healed.
 */
export const DISCONNECT_NOTICE_DELAY_MS = 1_500

/** Next backoff delay: double the current one, capped at the ceiling. */
export function nextReconnectDelay(current: number): number {
  return Math.min(current * 2, MAX_RECONNECT_DELAY_MS)
}
