import {
  startForward,
  type ForwardEvents,
  type ForwardHandle,
  type ForwardSpec,
  type TunnelTarget,
} from '#port-tunnel'
import { isLoopbackOrigin } from '#server-api'
import type { DriverKind, ServerSnapshot } from '#types'

/**
 * A live set of port forwards, reconciled against the ports each `/events`
 * snapshot offers. Shared by `yaac forward` and the desktop app. Unchanged
 * specs are never restarted, so adding a port does not drop other
 * forwards' open connections.
 */

/**
 * Whether a client reaching the server at `baseUrl` should bind the ports
 * it offers. Always under `k8s`. Under `containerless` the workspace binds
 * the ports itself on the server's machine, so a client on that machine
 * (a loopback origin) must not bind them too. An `ssh -L` tunnel to a
 * remote containerless server looks local and so gets no forwards.
 */
export function serverNeedsForwarder(driver: DriverKind, baseUrl: string): boolean {
  return driver !== 'containerless' || !isLoopbackOrigin(baseUrl)
}

/**
 * Every forward a snapshot offers, or only workspace `only`'s. Whether this
 * client should bind them at all is `serverNeedsForwarder`'s answer.
 */
export function snapshotForwards(snapshot: ServerSnapshot, only?: string): ForwardSpec[] {
  return snapshot.workspaces
    .filter((w) => only === undefined || w.workspaceId === only)
    .flatMap((w) => w.forwardedPorts.map(({ containerPort, hostPort }) =>
      ({ session: w.workspaceId, containerPort, hostPort })))
}

/** A forward's identity: workspace, container port and host port. */
function specKey(spec: ForwardSpec): string {
  return `${spec.session} ${spec.containerPort} ${spec.hostPort}`
}

/** How many ports above a taken host port a fallback bind tries. */
const FALLBACK_PORT_SPAN = 100

/**
 * A running forward. `localPort` is the port it holds on this machine:
 * `spec.hostPort`, or a fallback when that port was taken.
 */
export type LiveForward = ForwardSpec & { localPort: number }

export interface ForwardSetEvents extends ForwardEvents {
  onChange?: (forward: LiveForward, state: 'up' | 'down') => void
  /**
   * A forward could not bind its host port (nor, with `fallback`, any port
   * after it). The rest of the set still comes up, and the next reconcile
   * retries this one.
   */
  onBindError?: (spec: ForwardSpec, message: string) => void
}

export interface ForwardSet {
  /** Start new specs and stop missing ones, leaving the rest untouched. */
  reconcile(specs: ForwardSpec[]): Promise<void>
  live(): LiveForward[]
  close(): void
}

function isAddressInUse(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'EADDRINUSE'
}

/**
 * With `fallback`, a forward whose host port another process holds binds
 * the next free port above it instead, skipping ports other forwards in the
 * set ask for. The server picks host ports without seeing this machine
 * (docs/port-forward-tunnel.md), so a clash is only found here. A forward
 * keeps its fallback port until the server stops offering it, so its URL
 * stays put even after the original port frees up.
 */
export function createForwardSet(
  target: TunnelTarget,
  opts: { bindHost?: string; fallback?: boolean } & ForwardSetEvents = {},
): ForwardSet {
  const { onChange, onBindError, fallback = false, ...forwardOpts } = opts
  const live = new Map<string, { forward: LiveForward; handle: ForwardHandle }>()
  let closed = false
  // One reconcile at a time, or two would both bind a newly offered port.
  let running: Promise<void> = Promise.resolve()

  const apply = async (specs: ForwardSpec[]): Promise<void> => {
    if (closed) return
    const wanted = new Map(specs.map((s) => [specKey(s), s]))
    for (const [key, entry] of [...live]) {
      if (wanted.has(key)) continue
      live.delete(key)
      entry.handle.close()
      onChange?.(entry.forward, 'down')
    }
    const reserved = new Set(specs.map((s) => s.hostPort))
    for (const { forward } of live.values()) reserved.add(forward.localPort)
    for (const [key, spec] of wanted) {
      if (live.has(key)) continue
      try {
        const handle = await bind(spec, reserved)
        // close() may have run while binding.
        if (closed) {
          handle.close()
          return
        }
        const forward = { ...spec, localPort: handle.hostPort }
        reserved.add(forward.localPort)
        live.set(key, { forward, handle })
        onChange?.(forward, 'up')
      } catch (err) {
        onBindError?.(spec, err instanceof Error ? err.message : String(err))
      }
    }
  }

  /** Bind `spec.hostPort`, or with `fallback` the first free port above it. */
  const bind = async (spec: ForwardSpec, reserved: Set<number>): Promise<ForwardHandle> => {
    try {
      return await startForward(target, spec, forwardOpts)
    } catch (err) {
      if (!fallback || !isAddressInUse(err)) throw err
    }
    const last = Math.min(65535, spec.hostPort + FALLBACK_PORT_SPAN)
    for (let port = spec.hostPort + 1; port <= last; port++) {
      if (reserved.has(port)) continue
      try {
        return await startForward(target, { ...spec, hostPort: port }, forwardOpts)
      } catch (err) {
        if (!isAddressInUse(err)) throw err
      }
    }
    throw new Error(`no free port in ${String(spec.hostPort)}–${String(last)}`)
  }

  return {
    live: () => [...live.values()].map((e) => e.forward),
    reconcile(specs) {
      running = running.then(() => apply(specs))
      return running
    },
    close() {
      closed = true
      for (const { handle } of live.values()) handle.close()
      live.clear()
    },
  }
}
