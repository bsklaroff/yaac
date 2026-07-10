/**
 * Exponential-backoff reconnect policy shared by the server's two browser
 * WebSockets — the `/events` stream (useEvents) and the `/pty/attach` terminal
 * (SessionTerminal): start at 500ms and double on each failed attempt up to a
 * 10s ceiling, resetting to the initial delay once a socket opens.
 */
export const INITIAL_RECONNECT_DELAY_MS = 500
export const MAX_RECONNECT_DELAY_MS = 10_000

/** Next backoff delay: double the current one, capped at the ceiling. */
export function nextReconnectDelay(current: number): number {
  return Math.min(current * 2, MAX_RECONNECT_DELAY_MS)
}
