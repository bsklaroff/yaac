/**
 * A tiny in-process signal so route handlers can tell the events hub to
 * push a fresh snapshot the instant a session is created/restarted, instead
 * of waiting for the next periodic tick (up to ~5s). The daemon is a single
 * process (one EventHub), so a single module-level listener is enough.
 *
 * Wired in the daemon entrypoint: `onSessionListChanged(() => hub.publishSnapshot())`.
 */
let listener: (() => void) | null = null

/** Register the handler fired on each `notifySessionListChanged()`. Replaces any
 *  previous handler (last registration wins). */
export function onSessionListChanged(fn: () => void): void {
  listener = fn
}

/** Fire the registered handler, if any. No-op when nothing is listening. */
export function notifySessionListChanged(): void {
  listener?.()
}

/** Test helper: drop the registered handler. */
export function _resetSessionListChangedForTests(): void {
  listener = null
}
