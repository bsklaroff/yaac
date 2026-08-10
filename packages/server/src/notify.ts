/**
 * A tiny in-process signal so anything that changes what the worktree list
 * shows can tell the events hub to push a fresh snapshot immediately, instead
 * of waiting for the next periodic tick (up to ~5s). The server is a single
 * process (one EventHub), so a single module-level listener is enough.
 *
 * Wired in the server entrypoint: `onWorktreeListChanged(() => hub.publishSnapshot())`.
 *
 * Deliberately a zero-dependency module at the package root rather than part
 * of #domain/worktrees. The notifiers are spread across features — image
 * builds, plan usage, generated titles — and none of them otherwise depend on
 * the worktrees feature. Housing this in that barrel made all of them import
 * it for a one-line side effect, which is most of what tied the feature layer
 * into a cycle. It names the worktree list because that is what the snapshot
 * contains, not because it belongs to that feature.
 */
let listener: (() => void) | null = null

/** Register the handler fired on each `notifyWorktreeListChanged()`. Replaces any
 *  previous handler (last registration wins). */
export function onWorktreeListChanged(fn: () => void): void {
  listener = fn
}

/** Fire the registered handler, if any. No-op when nothing is listening. */
export function notifyWorktreeListChanged(): void {
  listener?.()
}

/** Test helper: drop the registered handler. */
export function _resetWorktreeListChangedForTests(): void {
  listener = null
}

/**
 * Wrap a listener so notification bursts coalesce: the first call fires
 * immediately (a worktree create should push its snapshot with zero
 * added latency), further calls inside `windowMs` collapse into one
 * trailing call. Keeps informer event storms (server start seeding N
 * pods, a multi-worktree teardown) from stampeding snapshot rebuilds.
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
