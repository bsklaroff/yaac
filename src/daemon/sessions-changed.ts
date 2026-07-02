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

/**
 * Wrap a listener so notification bursts coalesce: the first call fires
 * immediately (a session create should push its snapshot with zero
 * added latency), further calls inside `windowMs` collapse into one
 * trailing call. Keeps pod-watch event storms (daemon start seeding N
 * pods, a multi-session teardown) from stampeding snapshot rebuilds.
 */
export function coalesceCalls(fn: () => void, windowMs: number): () => void {
  let timer: NodeJS.Timeout | null = null
  let pending = false
  return () => {
    if (timer) {
      pending = true
      return
    }
    fn()
    timer = setTimeout(() => {
      timer = null
      if (pending) {
        pending = false
        fn()
      }
    }, windowMs)
  }
}
