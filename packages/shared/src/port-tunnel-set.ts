import {
  startForward,
  startHostRouter,
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
  /** The hostname router (`hostsPort`) is up, at this local port. */
  onHostsBound?: (port: number) => void
  /** The hostname router could not bind; the next reconcile retries. */
  onHostsError?: (message: string) => void
}

export interface ForwardSet {
  /** Start new specs and stop missing ones, leaving the rest untouched. */
  reconcile(specs: ForwardSpec[]): Promise<void>
  live(): LiveForward[]
  /** The port the hostname router holds, once it is up. */
  hostsPort(): number | undefined
  close(): void
}

function isAddressInUse(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'EADDRINUSE'
}

/**
 * Bind with `start(port)`, or with `fallback` the first port above `port`
 * that is free here and not in `reserved`.
 */
async function bindFrom(
  port: number,
  fallback: boolean,
  reserved: Set<number>,
  start: (port: number) => Promise<ForwardHandle>,
): Promise<ForwardHandle> {
  try {
    return await start(port)
  } catch (err) {
    if (!fallback || !isAddressInUse(err)) throw err
  }
  const last = Math.min(65535, port + FALLBACK_PORT_SPAN)
  for (let next = port + 1; next <= last; next++) {
    if (reserved.has(next)) continue
    try {
      return await start(next)
    } catch (err) {
      if (!isAddressInUse(err)) throw err
    }
  }
  throw new Error(`no free port in ${String(port)}–${String(last)}`)
}

/**
 * With `fallback`, a forward whose host port another process holds binds
 * the next free port above it instead, skipping ports other forwards in the
 * set ask for. The server picks host ports without seeing this machine
 * (docs/port-forward-tunnel.md), so a clash is only found here. A forward
 * keeps its fallback port until the server stops offering it, so its URL
 * stays put even after the original port frees up.
 *
 * With `hostsPort`, the set also binds one hostname router there (moving
 * up like a forward with `fallback`), which routes the workspace hostnames
 * of the forwards last asked for (docs/workspace-hostnames.md).
 */
export function createForwardSet(
  target: TunnelTarget,
  opts: { bindHost?: string; fallback?: boolean; hostsPort?: number } & ForwardSetEvents = {},
): ForwardSet {
  const { onChange, onBindError, onHostsBound, onHostsError, fallback = false, hostsPort, ...forwardOpts } = opts
  const live = new Map<string, { forward: LiveForward; handle: ForwardHandle }>()
  let offered: ForwardSpec[] = []
  let router: ForwardHandle | null = null
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
    offered = specs
    const reserved = new Set(specs.map((s) => s.hostPort))
    for (const { forward } of live.values()) reserved.add(forward.localPort)
    if (hostsPort !== undefined && !router) {
      try {
        const handle = await bindFrom(hostsPort, true, reserved, (port) => startHostRouter(target, port, route, forwardOpts))
        if (closed) {
          handle.close()
          return
        }
        router = handle
        reserved.add(handle.hostPort)
        onHostsBound?.(handle.hostPort)
      } catch (err) {
        onHostsError?.(err instanceof Error ? err.message : String(err))
      }
    }
    for (const [key, spec] of wanted) {
      if (live.has(key)) continue
      try {
        const handle = await bindFrom(spec.hostPort, fallback, reserved, (port) =>
          startForward(target, { ...spec, hostPort: port }, forwardOpts))
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

  /** The offered forward a workspace hostname names, or none when its id
   *  prefix names more than one workspace, as the server's router answers. */
  const route = ({ port, idPrefix }: { port: number; idPrefix: string }): ForwardSpec | undefined => {
    const matches = offered.filter((s) => s.session.startsWith(idPrefix))
    if (new Set(matches.map((s) => s.session)).size !== 1) return undefined
    return matches.find((s) => s.containerPort === port)
  }

  return {
    live: () => [...live.values()].map((e) => e.forward),
    hostsPort: () => router?.hostPort,
    reconcile(specs) {
      running = running.then(() => apply(specs))
      return running
    },
    close() {
      closed = true
      for (const { handle } of live.values()) handle.close()
      live.clear()
      router?.close()
      router = null
    },
  }
}
