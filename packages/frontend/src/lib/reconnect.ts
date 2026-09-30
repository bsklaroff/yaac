/**
 * Exponential-backoff reconnect policy for the SPA's two WebSockets: the
 * `/events` stream (useEvents) and the `/pty/attach` terminal
 * (WorkspaceTerminal). The delay doubles on each failure up to the maximum
 * and resets once a socket opens.
 */
export const INITIAL_RECONNECT_DELAY_MS = 500
export const MAX_RECONNECT_DELAY_MS = 10_000

/**
 * How long a terminal must stay disconnected before WorkspaceTerminal shows
 * a notice. Most drops heal within a second (the terminal re-attaches and
 * tmux repaints), so this must outlast the first reconnect attempt (the
 * initial delay plus an attach) to avoid announcing them.
 */
export const DISCONNECT_NOTICE_DELAY_MS = 1_500

/** Next backoff delay: double the current one, capped at the ceiling. */
export function nextReconnectDelay(current: number): number {
  return Math.min(current * 2, MAX_RECONNECT_DELAY_MS)
}
