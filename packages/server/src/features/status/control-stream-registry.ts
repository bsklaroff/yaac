/**
 * Registry of live per-worktree tmux control-mode command channels, keyed
 * by the worktree's Job name. Each running worktree's status watcher
 * (`status-watcher.ts`) holds one persistent `kubectl exec` stream to
 * the in-pod tmux server; it registers a send function here so other
 * server paths (the webapp terminals listing) can ride that stream
 * instead of spawning a fresh `kubectl exec` per call — the probe-volume
 * reduction that matters because every exec costs an apiserver→kubelet
 * connection plus a task in the pod's gVisor sentry.
 *
 * The watcher's client attaches read-only, so ONLY tmux commands marked
 * CMD_READONLY (list-windows, display-message, capture-pane, …) may be
 * sent through it; mutations (new-window, kill-window) must keep using
 * containerExec. Callers must treat a registered channel as best-effort:
 * a rejected send means the stream just died — fall back to exec.
 */

export type ControlStreamSend = (command: string) => Promise<string>

const registry = new Map<string, ControlStreamSend>()

/** Make a worktree's control-mode channel available. Replaces any earlier
 *  registration for the Job (a watcher respawn supersedes its old stream). */
export function registerWorktreeControlStream(jobName: string, send: ControlStreamSend): void {
  registry.set(jobName, send)
}

/**
 * Remove a registration, but only if it still points at `send` — a
 * watcher tearing down stream generation N must not remove the
 * generation-N+1 channel that already replaced it.
 */
export function unregisterWorktreeControlStream(jobName: string, send: ControlStreamSend): void {
  if (registry.get(jobName) === send) registry.delete(jobName)
}

/** The worktree's live command channel, or undefined when no watcher
 *  stream is up (prewarmed spares, stream mid-respawn, non-server CLI). */
export function worktreeControlStreamSend(jobName: string): ControlStreamSend | undefined {
  return registry.get(jobName)
}

/** Test-only: drop every registration. */
export function _clearControlStreamRegistryForTests(): void {
  registry.clear()
}
