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

export interface ForwardSetEvents extends ForwardEvents {
  onChange?: (spec: ForwardSpec, state: 'up' | 'down') => void
  /**
   * A forward could not bind its host port. The rest of the set still comes
   * up, and the next reconcile retries this one.
   */
  onBindError?: (spec: ForwardSpec, message: string) => void
}

export interface ForwardSet {
  /** Start new specs and stop missing ones, leaving the rest untouched. */
  reconcile(specs: ForwardSpec[]): Promise<void>
  live(): ForwardSpec[]
  close(): void
}

export function createForwardSet(
  target: TunnelTarget,
  opts: { bindHost?: string } & ForwardSetEvents = {},
): ForwardSet {
  const { onChange, onBindError, ...forwardOpts } = opts
  const live = new Map<string, { spec: ForwardSpec; handle: ForwardHandle }>()
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
      onChange?.(entry.spec, 'down')
    }
    for (const [key, spec] of wanted) {
      if (live.has(key)) continue
      try {
        const handle = await startForward(target, spec, forwardOpts)
        // close() may have run while binding.
        if (closed) {
          handle.close()
          return
        }
        live.set(key, { spec, handle })
        onChange?.(spec, 'up')
      } catch (err) {
        onBindError?.(spec, err instanceof Error ? err.message : String(err))
      }
    }
  }

  return {
    live: () => [...live.values()].map((e) => e.spec),
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
