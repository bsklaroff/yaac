/**
 * Process-local registry of port-forwarder stop functions keyed by
 * sessionId. The server creates forwarders when a session starts
 * (see `createSession`) and must tear them down when the session is
 * deleted or reaped; this module is the handoff point.
 *
 * Concurrent attaches to the same session share a single forwarder
 * set — register only the first one, and let re-registration for a
 * sessionId that already has forwarders be a no-op so the
 * server-restart restore pass can't double-register.
 */

import { containerExec } from '@/lib/k8s/exec'
import { kubectlRelay, reserveAvailablePort, startPortForwarders } from '@/lib/container/port'
import type { ReservedPort } from '@/lib/container/port'
import { CONTAINER_TMUX_SOCK } from '@/shared/paths'
import type { PortForwardConfig, PortMapping } from '@/shared/types'

interface SessionForwarders {
  stop: () => void
  ports: PortMapping[]
}

const forwarders = new Map<string, SessionForwarders>()

export function registerSessionForwarders(
  sessionId: string,
  stop: () => void,
  ports: ReadonlyArray<PortMapping>,
): void {
  if (forwarders.has(sessionId)) {
    // Already have forwarders for this session; drop the new ones to
    // avoid leaking handles.
    stop()
    return
  }
  forwarders.set(sessionId, {
    stop,
    ports: ports.map(({ containerPort, hostPort }) => ({ containerPort, hostPort })),
  })
}

/**
 * Host↔container mappings of the live forwarders for a session, empty
 * when none are registered. Feeds the `forwardedPorts` field of
 * session-list entries (and thus the webapp snapshot) — the registry is
 * the server's only record of which host ports a session actually holds.
 */
export function getSessionPorts(sessionId: string): PortMapping[] {
  return forwarders.get(sessionId)?.ports ?? []
}

export function stopSessionForwarders(sessionId: string): void {
  const entry = forwarders.get(sessionId)
  if (!entry) return
  forwarders.delete(sessionId)
  try {
    entry.stop()
  } catch {
    // Best-effort teardown — a wedged forwarder shouldn't block delete.
  }
}

export function hasSessionForwarders(sessionId: string): boolean {
  return forwarders.has(sessionId)
}

/**
 * Stop every registered forwarder. Called from the server's shutdown
 * handler so each relay's listener server is closed and each in-flight
 * `kubectl exec` child is signalled before the server exits. Without
 * this, relay children survive the server (orphaned to PID 1) and the
 * next server's `restoreAllSessionForwarders` adds new ones on top —
 * every restart compounds the count of live `kubectl exec` slots.
 */
export function stopAllSessionForwarders(): void {
  for (const sessionId of [...forwarders.keys()]) {
    stopSessionForwarders(sessionId)
  }
}

function shellEscape(str: string): string {
  return str.replace(/'/g, "'\\''")
}

/**
 * Render the tmux `status-right` value shown in a session's bottom bar.
 * Kept in a single helper so new sessions and server restarts both
 * produce the same format.
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
 * Overwrite the running session's tmux `status-right`. Used when ports
 * are provisioned after Job creation (server restart) so the displayed
 * port mapping matches the live forwarders.
 */
export async function setSessionStatusRight(
  jobName: string,
  projectSlug: string,
  sessionId: string,
  ports: ReadonlyArray<PortMapping>,
): Promise<void> {
  const value = buildStatusRight(projectSlug, sessionId, ports)
  await containerExec(
    jobName,
    `tmux -S ${CONTAINER_TMUX_SOCK} set-option -t yaac status-right '${shellEscape(value)}'`,
  )
}

/**
 * Reserve host ports, start relay forwarders into the given session pod,
 * register them for teardown, and refresh tmux status-right so the
 * displayed port mapping matches the live forwarders. Used by the
 * server-restart path only; new-session creation does this inline so
 * the ports are held across the pod-start window.
 */
export async function provisionSessionForwarders(
  projectSlug: string,
  sessionId: string,
  jobName: string,
  portForward: PortForwardConfig[] | undefined,
): Promise<PortMapping[]> {
  const reserved: ReservedPort[] = []
  if (portForward?.length) {
    for (const { containerPort, hostPortStart } of portForward) {
      const r = await reserveAvailablePort(containerPort, hostPortStart)
      reserved.push(r)
    }
  }

  // Always refresh status-right — even with no port forwards, the pod's
  // existing string may include stale port info from before the server
  // restarted that we want cleared.
  await setSessionStatusRight(jobName, projectSlug, sessionId, reserved)

  if (reserved.length === 0) return []

  const mappings = reserved.map(({ containerPort, hostPort }) => ({ containerPort, hostPort }))
  const stop = startPortForwarders(kubectlRelay(jobName), reserved)
  registerSessionForwarders(sessionId, stop, mappings)

  return mappings
}
