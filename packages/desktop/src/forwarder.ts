import { createForwardSet, type ForwardSet } from '@yaac/shared/port-tunnel-set'
import type { ForwardSpec } from '@yaac/shared/port-tunnel'
import type { ServerTarget } from '@yaac/shared/server-api'
import type { ServerSnapshot } from '@yaac/shared/types'

/**
 * The desktop shell as the resident port forwarder.
 *
 * The server cannot bind ports on the user's machine — under `k8s` it is a
 * pod, so a port it bound would be on the pod's loopback — so the listener
 * has to live in a client. This process is the natural one: it is
 * long-lived, tray-scoped, and already holds `/events`, which carries the
 * mapping (`forwardedPorts` on every worktree) in every snapshot. So the
 * same stream that drives the badge drives the forwards, and the webapp's
 * `127.0.0.1:<port>` links are true whenever the app is running.
 *
 * Bound to loopback and nothing else. A desktop app quietly serving a
 * developer's dev servers to the local network would be a surprise, and
 * the machine that wants to publish them is a headless one running `yaac
 * forward --bind`.
 */

/**
 * Every forward the snapshot says is on offer, across every worktree.
 *
 * Empty under `containerless`, where forwarding is not a thing a client
 * can do or needs to: a workspace's own processes bind the host ports, so
 * `forwardedPorts` there is the identity mapping over ports something is
 * ALREADY listening on. Binding them is either impossible (the dev server
 * holds the port, on this machine) or useless (against a remote one, where
 * every tunnelled connection dies because that driver's `dialPort` is a
 * refusal). Either way it is a retry loop that can never settle, so the
 * snapshot's own `driver` is what stops it before it starts.
 */
export function snapshotForwards(snapshot: ServerSnapshot): ForwardSpec[] {
  if (snapshot.driver === 'containerless') return []
  const specs: ForwardSpec[] = []
  for (const w of snapshot.worktrees) {
    for (const { containerPort, hostPort } of w.forwardedPorts) {
      specs.push({ session: w.worktreeId, containerPort, hostPort })
    }
  }
  return specs
}

export interface ForwarderDeps {
  /** Fresh target per rebuild — a server restart rotates port and secret,
   *  exactly as the events monitor re-resolves per connection. */
  resolveTarget(): Promise<ServerTarget>
  createSet?: typeof createForwardSet
  /** Bind failures and dropped connections, for the log. */
  onMessage?: (text: string) => void
}

export interface DesktopForwarder {
  /** Reconcile against a snapshot. Safe to call on every one — an
   *  unchanged offer is not restarted, so a snapshot pushed for an
   *  unrelated reason costs nothing. */
  apply(snapshot: ServerSnapshot): void
  stop(): void
}

export function startForwarder(deps: ForwarderDeps): DesktopForwarder {
  const createSet = deps.createSet ?? createForwardSet
  const say = deps.onMessage ?? ((): void => { /* quiet by default */ })
  let set: ForwardSet | null = null
  let targetUrl: string | null = null
  let stopped = false
  // One reconcile at a time, and only the LATEST snapshot pending: they
  // arrive faster than binds settle, and a queue of them would replay
  // states the server has already left.
  let running: Promise<void> = Promise.resolve()
  let pending: ServerSnapshot | null = null

  const rebuild = async (): Promise<void> => {
    const target = await deps.resolveTarget()
    // A switched server is a different set of forwards, so the old ones go
    // rather than being reconciled onto the new target.
    if (set && targetUrl === target.baseUrl) return
    set?.close()
    targetUrl = target.baseUrl
    set = createSet(
      { baseUrl: target.baseUrl, secret: target.secret },
      {
        onBindError: (spec, message) =>
          say(`port ${String(spec.hostPort)} could not be bound: ${message}`),
        onConnectionError: (message) => say(`forwarded connection failed: ${message}`),
      },
    )
  }

  const step = async (snapshot: ServerSnapshot): Promise<void> => {
    try {
      await rebuild()
      if (stopped) return
      await set?.reconcile(snapshotForwards(snapshot))
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
