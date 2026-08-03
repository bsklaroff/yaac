/**
 * Process-local registry of port-forwarder stop functions keyed by
 * sessionId. The server creates forwarders when a session starts
 * (see `createSession`) and must tear them down when the session is
 * deleted or reaped; this module is the handoff point.
 *
 * A session's entry accumulates registrations: the create/restore batch
 * plus any reactive single-port appends (addSessionForwarder), merged so
 * neither can tear the other down. The server-restart restore pass
 * guards with hasSessionForwarders before provisioning, so it never
 * double-registers a batch.
 */

import { relayTcpFactory, sessionExec } from '#platform/k8s/stream-relay'
import { reserveAvailablePort, startPortForwarders } from '#platform/container'
import type { ReservedPort } from '#platform/container'
import { CONTAINER_TMUX_SOCK } from '@yaac/shared/paths'
import { ServerError } from '@yaac/shared/errors'
import type { PortForwardConfig, PortMapping } from '@yaac/shared/types'

interface SessionForwarders {
  /** One stop-fn per registration: the create/restore batch plus any
   *  later single-port appends (addSessionForwarder). */
  stops: Array<() => void>
  ports: PortMapping[]
}

/** Ceiling on live forwards per session — bounds a hostile flood of
 *  forward-port actions (and keeps well under streamd's stream cap). */
export const MAX_FORWARDS_PER_SESSION = 32

const forwarders = new Map<string, SessionForwarders>()

export function registerSessionForwarders(
  sessionId: string,
  stop: () => void,
  ports: ReadonlyArray<PortMapping>,
): void {
  const mapped = ports.map(({ containerPort, hostPort }) => ({ containerPort, hostPort }))
  const entry = forwarders.get(sessionId)
  if (entry) {
    // Merge, never drop: create's batch registration can race a reactive
    // addSessionForwarder from the forward-port route (the pod is Running
    // — and its dev servers detectable — well before create returns).
    // Dropping either side would tear down live forwards; a merged entry
    // just holds both, and stopSessionForwarders runs every stop.
    entry.stops.push(stop)
    entry.ports.push(...mapped)
    return
  }
  forwarders.set(sessionId, { stops: [stop], ports: mapped })
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
  for (const stop of entry.stops) {
    try {
      stop()
    } catch {
      // Best-effort teardown — a wedged forwarder shouldn't block delete.
    }
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
  await sessionExec(
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
  const stop = startPortForwarders(relayTcpFactory(sessionId), reserved)
  registerSessionForwarders(sessionId, stop, mappings)

  return mappings
}

/**
 * Forward ONE additional container port on a running session — the
 * reactive path behind the webapp's "forward this port" action, appended
 * to whatever forwarders the session already holds (creating its registry
 * entry when it has none). Reserves a host port starting at the container
 * port itself, starts a relay listener over the same RelayFactory the
 * create/restore paths use, and refreshes tmux status-right so the bar
 * matches the live set. Idempotent per container port.
 */
export async function addSessionForwarder(
  projectSlug: string,
  sessionId: string,
  jobName: string,
  containerPort: number,
): Promise<PortMapping> {
  const existing = getSessionPorts(sessionId).find((p) => p.containerPort === containerPort)
  if (existing) return existing
  if (getSessionPorts(sessionId).length >= MAX_FORWARDS_PER_SESSION) {
    throw new ServerError(
      'CONFLICT',
      `session ${sessionId.slice(0, 8)} already holds ${MAX_FORWARDS_PER_SESSION} forwarded ports`,
    )
  }

  const reserved = await reserveAvailablePort(containerPort, containerPort)

  // Re-check after the await: a concurrent request for the same port may
  // have won the race while we reserved — release ours and defer to it.
  const winner = getSessionPorts(sessionId).find((p) => p.containerPort === containerPort)
  if (winner || getSessionPorts(sessionId).length >= MAX_FORWARDS_PER_SESSION) {
    reserved.server.close()
    if (winner) return winner
    throw new ServerError(
      'CONFLICT',
      `session ${sessionId.slice(0, 8)} already holds ${MAX_FORWARDS_PER_SESSION} forwarded ports`,
    )
  }

  const mapping = { containerPort: reserved.containerPort, hostPort: reserved.hostPort }
  const stop = startPortForwarders(relayTcpFactory(sessionId), [reserved])

  const entry = forwarders.get(sessionId)
  if (entry) {
    entry.stops.push(stop)
    entry.ports.push(mapping)
  } else {
    forwarders.set(sessionId, { stops: [stop], ports: [mapping] })
  }

  // Cosmetic — a failed status-right refresh must not undo a live forward.
  await setSessionStatusRight(jobName, projectSlug, sessionId, getSessionPorts(sessionId))
    .catch(() => {})

  return mapping
}
