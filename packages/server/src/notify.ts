/**
 * The one channel by which server state reaches a browser.
 *
 * The rule (docs/layered-server.md): **every store the snapshot reads
 * notifies at its own mutation site.** Rows announce themselves at the
 * event door and in the intent writers, the informer cache in its delta
 * handler, the in-memory registries in their mutators, the proxy's state
 * on the events it reports. Nothing above them pushes — routes translate
 * and return, and the reconciler knows nothing about snapshots.
 *
 * The signal is contentless on purpose: it says "something changed", and
 * the one listener — the api layer's snapshot hub, wired in the server
 * entrypoint as `onWorkspaceListChanged(() => hub.publishSnapshot())` —
 * answers by rebuilding the whole snapshot, diffing it against what it
 * last sent, and broadcasting only a difference. So a notify that changed
 * nothing visible costs a rebuild rather than a push, and an idle server
 * rebuilds nothing at all. The server is a single process (one EventHub),
 * so a single module-level listener is enough.
 *
 * Deliberately a zero-dependency module at the package root rather than part
 * of #domain/workspaces. The notifiers are spread across every layer — image
 * builds, plan usage, rows, forwarders — and none of them otherwise depend on
 * the workspaces feature. Housing this in that barrel made all of them import
 * it for a one-line side effect, which is most of what tied the feature layer
 * into a cycle. It names the workspace list because that is what the snapshot
 * mostly contains, not because it belongs to that feature.
 */
let listener: (() => void) | null = null

/** Register the handler fired on each `notifyWorkspaceListChanged()`. Replaces any
 *  previous handler (last registration wins). */
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
 * Wrap a listener so notification bursts coalesce: the first call fires
 * immediately (a workspace create should push its snapshot with zero
 * added latency), further calls inside `windowMs` collapse into one
 * trailing call. Keeps informer event storms (server start seeding N
 * pods, a multi-workspace teardown) from stampeding snapshot rebuilds.
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
