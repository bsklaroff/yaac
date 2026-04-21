/**
 * Process-local registry of port-forwarder stop functions keyed by
 * sessionId. The daemon creates forwarders when a session starts
 * (see `createSession`) and must tear them down when the session is
 * deleted or reaped; this module is the handoff point.
 *
 * Concurrent attaches to the same session share a single forwarder
 * set — register only the first one, and let re-registration for a
 * sessionId that already has forwarders be a no-op so
 * prewarm-claim paths can't double-register.
 */

import { execPodmanWithRetry } from '@/lib/container/runtime'
import { podmanRelay, reserveAvailablePort, startPortForwarders } from '@/lib/container/port'
import type { ReservedPort } from '@/lib/container/port'
import type { PortForwardConfig, PortMapping } from '@/shared/types'

const forwarders = new Map<string, () => void>()

export function registerSessionForwarders(sessionId: string, stop: () => void): void {
  if (forwarders.has(sessionId)) {
    // Already have forwarders for this session; drop the new ones to
    // avoid leaking handles.
    stop()
    return
  }
  forwarders.set(sessionId, stop)
}

export function stopSessionForwarders(sessionId: string): void {
  const stop = forwarders.get(sessionId)
  if (!stop) return
  forwarders.delete(sessionId)
  try {
    stop()
  } catch {
    // Best-effort teardown — a wedged forwarder shouldn't block delete.
  }
}

export function hasSessionForwarders(sessionId: string): boolean {
  return forwarders.has(sessionId)
}

function shellEscape(str: string): string {
  return str.replace(/'/g, "'\\''")
}

/**
 * Render the tmux `status-right` value shown in a session's bottom bar.
 * Kept in a single helper so new sessions, prewarm claims, and daemon
 * restarts all produce the same format.
 */
export function buildStatusRight(
  projectSlug: string,
  sessionId: string,
  ports: ReadonlyArray<PortMapping>,
): string {
  const portInfo = ports.length > 0
    ? ' ' + ports.map((p) => `:${p.hostPort}->${p.containerPort}`).join(' ')
    : ''
  return ` ${projectSlug} ${sessionId.slice(0, 8)}${portInfo} `
}

/**
 * Overwrite the running container's tmux `status-right`. Used when
 * ports are provisioned after container creation (prewarm claim, daemon
 * restart) so the displayed port mapping matches the live forwarders.
 */
export function setSessionStatusRight(
  containerName: string,
  projectSlug: string,
  sessionId: string,
  ports: ReadonlyArray<PortMapping>,
): void {
  const value = buildStatusRight(projectSlug, sessionId, ports)
  execPodmanWithRetry(
    `podman exec ${containerName} tmux set-option -t yaac status-right '${shellEscape(value)}'`,
  )
}

/**
 * Reserve host ports, start relay forwarders into the given container,
 * register them for teardown, and refresh tmux status-right so the
 * displayed port mapping matches the live forwarders. Used by the
 * prewarm-claim and daemon-restart paths; new-session creation does
 * this inline so the ports are held across the container-start
 * window.
 */
export async function provisionSessionForwarders(
  projectSlug: string,
  sessionId: string,
  containerName: string,
  portForward: PortForwardConfig[] | undefined,
): Promise<PortMapping[]> {
  const reserved: ReservedPort[] = []
  if (portForward?.length) {
    for (const { containerPort, hostPortStart } of portForward) {
      const r = await reserveAvailablePort(containerPort, hostPortStart)
      reserved.push(r)
    }
  }

  // Always refresh status-right — even with no port forwards, the
  // prewarm container's baked-in string may include stale info we
  // want cleared.
  setSessionStatusRight(containerName, projectSlug, sessionId, reserved)

  if (reserved.length === 0) return []

  const stop = startPortForwarders(podmanRelay(containerName), reserved)
  registerSessionForwarders(sessionId, stop)

  return reserved.map(({ containerPort, hostPort }) => ({ containerPort, hostPort }))
}
