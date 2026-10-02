import {
  createForwardSet,
  serverNeedsForwarder,
  snapshotForwards,
  type ForwardSet,
} from '@yaac/shared/port-tunnel-set'
import type { ServerTarget } from '@yaac/shared/server-api'
import type { ServerSnapshot } from '@yaac/shared/types'

/**
 * The desktop shell as a resident port forwarder. The server can't bind
 * ports on the user's machine (under `k8s` it is a pod), so a client holds
 * the listeners. This process is long-lived and already receives every
 * snapshot's `forwardedPorts` over `/events`, so the webapp's
 * `127.0.0.1:<port>` links work whenever the app runs. See
 * docs/port-forward-tunnel.md.
 *
 * It binds loopback only. To publish forwards on the network, use
 * `yaac forward --bind`.
 */

export interface ForwarderDeps {
  /** Re-resolved on every snapshot, since the server may have changed. */
  resolveTarget(): Promise<ServerTarget>
  createSet?: typeof createForwardSet
  /** Bind failures and dropped connections, for the log. */
  onMessage?: (text: string) => void
}

export interface DesktopForwarder {
  /** Reconcile against a snapshot. Unchanged forwards are not restarted. */
  apply(snapshot: ServerSnapshot): void
  stop(): void
}

export function startForwarder(deps: ForwarderDeps): DesktopForwarder {
  const createSet = deps.createSet ?? createForwardSet
  const say = deps.onMessage ?? ((): void => { /* quiet by default */ })
  let set: ForwardSet | null = null
  let targetUrl: string | null = null
  let stopped = false
  // One reconcile at a time, keeping only the latest pending snapshot:
  // snapshots arrive faster than binds settle.
  let running: Promise<void> = Promise.resolve()
  let pending: ServerSnapshot | null = null

  /** Returns the origin the set targets; a new server gets a fresh set. */
  const rebuild = async (): Promise<string> => {
    const target = await deps.resolveTarget()
    if (set && targetUrl === target.baseUrl) return target.baseUrl
    set?.close()
    targetUrl = target.baseUrl
    set = createSet(
      { baseUrl: target.baseUrl },
      {
        onBindError: (spec, message) =>
          say(`port ${String(spec.hostPort)} could not be bound: ${message}`),
        onConnectionError: (message) => say(`forwarded connection failed: ${message}`),
      },
    )
    return target.baseUrl
  }

  const step = async (snapshot: ServerSnapshot): Promise<void> => {
    try {
      const baseUrl = await rebuild()
      if (stopped) return
      // Nothing against a containerless server on this machine, whose
      // workspace processes already hold the ports themselves.
      await set?.reconcile(serverNeedsForwarder(snapshot.driver, baseUrl) ? snapshotForwards(snapshot) : [])
    } catch (err) {
      say(`forwarding paused: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const drain = (): void => {
    running = running.then(async () => {
      while (pending && !stopped) {
        const snapshot = pending
        pending = null
        await step(snapshot)
      }
    })
  }

  return {
    apply(snapshot) {
      if (stopped) return
      pending = snapshot
      drain()
    },
    stop() {
      stopped = true
      pending = null
      set?.close()
      set = null
      targetUrl = null
    },
  }
}
