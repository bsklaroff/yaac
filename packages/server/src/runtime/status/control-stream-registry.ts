/**
 * Registry of live per-workspace tmux control-mode channels, keyed by the
 * workspace's unit (Job) name. Each status watcher registers its stream's
 * send function so other read-only queries (the terminal listing) can reuse
 * it instead of a fresh exec, which is costly under k8s (an apiserver to
 * kubelet connection plus a gVisor task per call).
 *
 * The client attaches read-only, so only CMD_READONLY tmux commands
 * (list-windows, display-message, capture-pane, …) may be sent; mutations
 * use the driver's exec. Treat a channel as best-effort and fall back to
 * exec when a send is rejected.
 */

export type ControlStreamSend = (command: string) => Promise<string>

const registry = new Map<string, ControlStreamSend>()

/** Register a workspace's channel, replacing any earlier one (a watcher
 *  respawn supersedes its old stream). */
export function registerWorkspaceControlStream(jobName: string, send: ControlStreamSend): void {
  registry.set(jobName, send)
}

/**
 * Remove a registration only if it still points at `send`, so tearing down
 * an old stream never removes its replacement.
 */
export function unregisterWorkspaceControlStream(jobName: string, send: ControlStreamSend): void {
  if (registry.get(jobName) === send) registry.delete(jobName)
}

/** The workspace's live channel, or undefined when no watcher stream is up
 *  (spares, mid-respawn, outside the server). */
export function workspaceControlStreamSend(jobName: string): ControlStreamSend | undefined {
  return registry.get(jobName)
}

/** Test-only: drop every registration. */
export function _clearControlStreamRegistryForTests(): void {
  registry.clear()
}
