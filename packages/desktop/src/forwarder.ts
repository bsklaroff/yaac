import {
  createForwardSet,
  serverNeedsForwarder,
  snapshotForwards,
  type ForwardSet,
} from '@yaac/shared/port-tunnel-set'
import { isLoopbackOrigin, type ServerTarget } from '@yaac/shared/server-api'
import { WORKSPACE_HOSTS_PORT } from '@yaac/shared/workspace-hosts'
import type { ServerSnapshot } from '@yaac/shared/types'

/**
 * The desktop shell as a resident port forwarder. The server can't bind
 * ports on the user's machine (under `k8s` it is a pod), so a client holds
 * the listeners. This process is long-lived and already receives every
 * snapshot's `forwardedPorts` over `/events`, so `127.0.0.1:<port>` reaches
 * each workspace port whenever the app runs. See
 * docs/port-forward-tunnel.md.
 *
 * It binds loopback only. To publish forwards on the network, use
 * `yaac forward --bind`. A host port something else on this machine holds
 * is bound at the next free port instead, which the log reports.
 *
 * For a server on another machine it also routes the workspace hostnames
 * (docs/workspace-hostnames.md) and tells the page where (`hostsPort`,
 * `onHostsPort`), so the preview pane can load them. A server on this
 * machine routes them on its own port.
 */

export interface ForwarderDeps {
  /** Re-resolved on every snapshot, since the server may have changed. */
  resolveTarget(): Promise<ServerTarget>
  createSet?: typeof createForwardSet
  /** Bind failures and dropped connections, for the log. */
  onMessage?: (text: string) => void
  /** The hostname router came up at this port, or went away. */
  onHostsPort?: (port: number | null) => void
}

export interface DesktopForwarder {
  /** Reconcile against a snapshot. Unchanged forwards are not restarted. */
  apply(snapshot: ServerSnapshot): void
  /** Where this app routes workspace hostnames, if it does. */
  hostsPort(): number | null
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
  let hostsPort: number | null = null
  const publishHostsPort = (port: number | null): void => {
    if (port === hostsPort) return
    hostsPort = port
    deps.onHostsPort?.(port)
  }

  /** Returns the origin the set targets; a new server gets a fresh set. */
  const rebuild = async (): Promise<string> => {
    const target = await deps.resolveTarget()
    if (set && targetUrl === target.baseUrl) return target.baseUrl
    set?.close()
    publishHostsPort(null)
    targetUrl = target.baseUrl
    set = createSet(
      { baseUrl: target.baseUrl },
      {
        fallback: true,
        ...(isLoopbackOrigin(target.baseUrl) ? {} : { hostsPort: WORKSPACE_HOSTS_PORT }),
        onHostsBound: (port) => { if (!stopped) publishHostsPort(port) },
        onHostsError: (message) => say(`workspace hostnames could not be routed: ${message}`),
        onChange: (f, state) => {
          if (state === 'up' && f.localPort !== f.hostPort) {
            say(`port ${String(f.hostPort)} is in use here; forwarding it at ${String(f.localPort)}`)
          }
        },
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
    hostsPort: () => hostsPort,
    stop() {
      stopped = true
      pending = null
      set?.close()
      set = null
      targetUrl = null
      // The page may have the port from us; a successor starting empty
      // would never tell it otherwise.
      publishHostsPort(null)
    },
  }
}
