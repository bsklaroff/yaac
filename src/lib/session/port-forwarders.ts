/**
 * Process-local registry of port-forwarder stop functions keyed by
 * sessionId. The daemon creates forwarders when a session starts
 * (see `createSession`) and must tear them down when the session is
 * deleted or reaped; this module is the handoff point.
 *
 * Concurrent attaches to the same session share a single forwarder
 * set — register only the first one, and let re-registration for a
 * sessionId that already has forwarders be a no-op so the
 * daemon-restart restore pass can't double-register.
 */

import { containerExec } from '@/lib/k8s/exec'
import { kubectlRelay, reserveAvailablePort, startPortForwarders } from '@/lib/container/port'
import type { ReservedPort } from '@/lib/container/port'
import { CONTAINER_TMUX_SOCK } from '@/shared/paths'
import type { PortForwardConfig, PortMapping } from '@/shared/types'

/** A single dynamically-detected forward: its mapping plus its own teardown. */
interface DynamicForwarder {
  mapping: PortMapping
  stop: () => void
}

interface SessionForwarders {
  /** Teardown for the static `portForward` batch (no-op when none). */
  batchStop: () => void
  /** Static `portForward` mappings (detected flag absent). */
  batchPorts: PortMapping[]
  /** Whether the static batch has been provisioned — the restore pass's
   *  idempotency guard keys on this, not on mere entry existence, since the
   *  detector can create an entry (dynamic ports only) before any batch. */
  batchProvisioned: boolean
  /** Detected forwards keyed by containerPort (each `detected: true`). */
  dynamic: Map<number, DynamicForwarder>
  /** Teardown for the per-session port detector loop, if running. */
  detectorStop?: () => void
}

const forwarders = new Map<string, SessionForwarders>()

/** Get or lazily create the forwarder entry for a session. Lazy creation
 *  lets the detector attach to a session that declared no static ports. */
function ensure(sessionId: string): SessionForwarders {
  let entry = forwarders.get(sessionId)
  if (!entry) {
    entry = { batchStop: () => {}, batchPorts: [], batchProvisioned: false, dynamic: new Map() }
    forwarders.set(sessionId, entry)
  }
  return entry
}

export function registerSessionForwarders(
  sessionId: string,
  stop: () => void,
  ports: ReadonlyArray<PortMapping>,
): void {
  const entry = ensure(sessionId)
  if (entry.batchProvisioned) {
    // Already have a static batch for this session; drop the new one to
    // avoid leaking handles.
    stop()
    return
  }
  entry.batchStop = stop
  entry.batchPorts = ports.map(({ containerPort, hostPort }) => ({ containerPort, hostPort }))
  entry.batchProvisioned = true
}

/**
 * Host↔container mappings of the live forwarders for a session, empty
 * when none are registered. Feeds the `forwardedPorts` field of
 * session-list entries (and thus the webapp snapshot) — the registry is
 * the daemon's only record of which host ports a session actually holds.
 * Static (config) ports come first, then detected ones.
 */
export function getSessionPorts(sessionId: string): PortMapping[] {
  const entry = forwarders.get(sessionId)
  if (!entry) return []
  return [...entry.batchPorts, ...[...entry.dynamic.values()].map((d) => d.mapping)]
}

/** Whether a container port is already forwarded (static or detected) for a
 *  session — the detector's guard against double-forwarding a port that a
 *  static `portForward` entry already covers. */
export function hasForwardedPort(sessionId: string, containerPort: number): boolean {
  const entry = forwarders.get(sessionId)
  if (!entry) return false
  return entry.batchPorts.some((p) => p.containerPort === containerPort)
    || entry.dynamic.has(containerPort)
}

/** Add a detected forward (marked `detected: true`) to a session's set. A
 *  no-op if that container port is already tracked, dropping the new stop. */
export function addDetectedForwarder(
  sessionId: string,
  mapping: PortMapping,
  stop: () => void,
): void {
  const entry = ensure(sessionId)
  if (entry.dynamic.has(mapping.containerPort)) {
    stop()
    return
  }
  entry.dynamic.set(mapping.containerPort, {
    mapping: { containerPort: mapping.containerPort, hostPort: mapping.hostPort, detected: true },
    stop,
  })
}

/** Tear down a single detected forward (the pod stopped listening on it). */
export function removeDetectedForwarder(sessionId: string, containerPort: number): void {
  const entry = forwarders.get(sessionId)
  const dyn = entry?.dynamic.get(containerPort)
  if (!entry || !dyn) return
  entry.dynamic.delete(containerPort)
  try {
    dyn.stop()
  } catch {
    // Best-effort — a wedged relay shouldn't block detector reconciliation.
  }
}

/** Register the detector loop's teardown so session teardown kills it too.
 *  A no-op if a detector is already recorded, dropping the new stop. */
export function setSessionDetector(sessionId: string, stop: () => void): void {
  const entry = ensure(sessionId)
  if (entry.detectorStop) {
    stop()
    return
  }
  entry.detectorStop = stop
}

/** Whether a detector loop is already running for a session. */
export function hasSessionDetector(sessionId: string): boolean {
  return !!forwarders.get(sessionId)?.detectorStop
}

export function stopSessionForwarders(sessionId: string): void {
  const entry = forwarders.get(sessionId)
  if (!entry) return
  forwarders.delete(sessionId)
  // Detector first so it stops adding dynamic forwards mid-teardown.
  try { entry.detectorStop?.() } catch { /* best-effort */ }
  for (const dyn of entry.dynamic.values()) {
    try { dyn.stop() } catch { /* best-effort */ }
  }
  try {
    entry.batchStop()
  } catch {
    // Best-effort teardown — a wedged forwarder shouldn't block delete.
  }
}

/** Whether a session's static forwarders have been provisioned. The restore
 *  pass skips sessions that already have them. */
export function hasSessionForwarders(sessionId: string): boolean {
  return forwarders.get(sessionId)?.batchProvisioned ?? false
}

/**
 * Stop every registered forwarder. Called from the daemon's shutdown
 * handler so each relay's listener server is closed and each in-flight
 * `kubectl exec` child is signalled before the daemon exits. Without
 * this, relay children survive the daemon (orphaned to PID 1) and the
 * next daemon's `restoreAllSessionForwarders` adds new ones on top —
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
 * Kept in a single helper so new sessions and daemon restarts both
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
 * are provisioned after Job creation (daemon restart) so the displayed
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
 * daemon-restart path only; new-session creation does this inline so
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
  // existing string may include stale port info from before the daemon
  // restarted that we want cleared.
  await setSessionStatusRight(jobName, projectSlug, sessionId, reserved)

  if (reserved.length === 0) return []

  const mappings = reserved.map(({ containerPort, hostPort }) => ({ containerPort, hostPort }))
  const stop = startPortForwarders(kubectlRelay(jobName), reserved)
  registerSessionForwarders(sessionId, stop, mappings)

  return mappings
}
