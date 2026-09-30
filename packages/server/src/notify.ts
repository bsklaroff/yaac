/**
 * The single signal by which server state reaches browsers.
 *
 * Every store the snapshot reads calls `notifyWorkspaceListChanged` where it
 * mutates (docs/layered-server.md); routes and the reconciler never push.
 * The signal carries no content: the one listener, the api layer's snapshot
 * hub, rebuilds the snapshot, diffs it against what it last sent, and
 * broadcasts only the difference. A notify that changes nothing visible
 * costs a rebuild, and an idle server rebuilds nothing.
 *
 * A dependency-free module at the package root because notifiers live in
 * every layer (image builds, plan usage, rows, forwarders). It is named for
 * the workspace list only because that is most of the snapshot.
 */
let listener: (() => void) | null = null

/** Register the handler for `notifyWorkspaceListChanged()`, replacing any
 *  previous one. */
export function onWorkspaceListChanged(fn: () => void): void {
  listener = fn
}

/** Fire the registered handler, if any. No-op when nothing is listening. */
export function notifyWorkspaceListChanged(): void {
  listener?.()
}

/** Test helper: drop the registered handler. */
export function _resetWorkspaceListChangedForTests(): void {
  listener = null
}

/**
 * Coalesce bursts of calls: the first call fires immediately (so a create
 * is pushed with no delay), and further calls within `windowMs` collapse
 * into one trailing call. Keeps informer event storms from triggering many
 * snapshot rebuilds.
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
