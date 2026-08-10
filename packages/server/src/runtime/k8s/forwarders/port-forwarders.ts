/**
 * Process-local registry of port-forwarder stop functions keyed by
 * worktreeId. The server creates forwarders when a worktree starts
 * (see `createWorktree`) and must tear them down when the worktree is
 * deleted or reaped; this module is the handoff point.
 *
 * A worktree's entry accumulates registrations: the create/restore batch
 * plus any reactive single-port appends (addWorktreeForwarder), merged so
 * neither can tear the other down. The server-restart restore pass
 * guards with hasWorktreeForwarders before provisioning, so it never
 * double-registers a batch.
 */

import { relayTcpFactory, podExec } from '#platform/k8s'
import { reserveAvailablePort, startPortForwarders } from '#platform/port'
import type { ReservedPort } from '#platform/port'
import { CONTAINER_TMUX_SOCK } from '@yaac/shared/paths'
import { ServerError } from '@yaac/shared/errors'
import { shellEscape } from '#platform/shell'
import type { PortForwardConfig, PortMapping } from '@yaac/shared/types'

interface WorktreeForwarders {
  /** One stop-fn per registration: the create/restore batch plus any
   *  later single-port appends (addWorktreeForwarder). */
  stops: Array<() => void>
  ports: PortMapping[]
}

/** Ceiling on live forwards per worktree — bounds a hostile flood of
 *  forward-port actions (and keeps well under streamd's stream cap). */
export const MAX_FORWARDS_PER_SESSION = 32

const forwarders = new Map<string, WorktreeForwarders>()

export function registerWorktreeForwarders(
  worktreeId: string,
  stop: () => void,
  ports: ReadonlyArray<PortMapping>,
): void {
  const mapped = ports.map(({ containerPort, hostPort }) => ({ containerPort, hostPort }))
  const entry = forwarders.get(worktreeId)
  if (entry) {
    // Merge, never drop: create's batch registration can race a reactive
    // addWorktreeForwarder from the forward-port route (the pod is Running
    // — and its dev servers detectable — well before create returns).
    // Dropping either side would tear down live forwards; a merged entry
    // just holds both, and stopWorktreeForwarders runs every stop.
    entry.stops.push(stop)
    entry.ports.push(...mapped)
    return
  }
  forwarders.set(worktreeId, { stops: [stop], ports: mapped })
}

/**
 * Host↔container mappings of the live forwarders for a worktree, empty
 * when none are registered. Feeds the `forwardedPorts` field of
 * worktree-list entries (and thus the webapp snapshot) — the registry is
 * the server's only record of which host ports a worktree actually holds.
 */
export function getWorktreePorts(worktreeId: string): PortMapping[] {
  return forwarders.get(worktreeId)?.ports ?? []
}

export function stopWorktreeForwarders(worktreeId: string): void {
  const entry = forwarders.get(worktreeId)
  if (!entry) return
  forwarders.delete(worktreeId)
  for (const stop of entry.stops) {
    try {
      stop()
    } catch {
      // Best-effort teardown — a wedged forwarder shouldn't block delete.
    }
  }
}

export function hasWorktreeForwarders(worktreeId: string): boolean {
  return forwarders.has(worktreeId)
}

/**
 * Stop every registered forwarder. Called from the server's shutdown
 * handler so each relay's listener server is closed and each in-flight
 * `kubectl exec` child is signalled before the server exits. Without
 * this, relay children survive the server (orphaned to PID 1) and the
 * next server's `restoreAllWorktreeForwarders` adds new ones on top —
 * every restart compounds the count of live `kubectl exec` slots.
 */
export function stopAllWorktreeForwarders(): void {
  for (const worktreeId of [...forwarders.keys()]) {
    stopWorktreeForwarders(worktreeId)
  }
}

/**
 * Render the tmux `status-right` value shown in a worktree's bottom bar.
 * Kept in a single helper so new worktrees and server restarts both
 * produce the same format.
 */
export function buildStatusRight(
  projectSlug: string,
  worktreeId: string,
  ports: ReadonlyArray<PortMapping>,
): string {
  const portInfo = ports.length > 0
    ? ' ' + ports.map((p) => `:${p.hostPort}->${p.containerPort}`).join(' ')
    : ''
  return ` ${projectSlug} ${worktreeId.slice(0, 8)}${portInfo} `
}

/**
 * Overwrite the running worktree's tmux `status-right`. Used when ports
 * are provisioned after Job creation (server restart) so the displayed
 * port mapping matches the live forwarders.
 */
export async function setWorktreeStatusRight(
  jobName: string,
  projectSlug: string,
  worktreeId: string,
  ports: ReadonlyArray<PortMapping>,
): Promise<void> {
  const value = buildStatusRight(projectSlug, worktreeId, ports)
  await podExec(
    jobName,
    `tmux -S ${CONTAINER_TMUX_SOCK} set-option -t yaac status-right '${shellEscape(value)}'`,
  )
}

/**
 * Reserve host ports, start relay forwarders into the given worktree pod,
 * register them for teardown, and refresh tmux status-right so the
 * displayed port mapping matches the live forwarders. Used by the
 * server-restart path only; new-worktree creation does this inline so
 * the ports are held across the pod-start window.
 */
export async function provisionWorktreeForwarders(
  projectSlug: string,
  worktreeId: string,
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
  await setWorktreeStatusRight(jobName, projectSlug, worktreeId, reserved)

  if (reserved.length === 0) return []

  const mappings = reserved.map(({ containerPort, hostPort }) => ({ containerPort, hostPort }))
  const stop = startPortForwarders(relayTcpFactory(worktreeId), reserved)
  registerWorktreeForwarders(worktreeId, stop, mappings)

  return mappings
}

/**
 * Forward ONE additional container port on a running worktree — the
 * reactive path behind the webapp's "forward this port" action, appended
 * to whatever forwarders the worktree already holds (creating its registry
 * entry when it has none). Reserves a host port starting at the container
 * port itself, starts a relay listener over the same RelayFactory the
 * create/restore paths use, and refreshes tmux status-right so the bar
 * matches the live set. Idempotent per container port.
 */
export async function addWorktreeForwarder(
  projectSlug: string,
  worktreeId: string,
  jobName: string,
  containerPort: number,
): Promise<PortMapping> {
  const existing = getWorktreePorts(worktreeId).find((p) => p.containerPort === containerPort)
  if (existing) return existing
  if (getWorktreePorts(worktreeId).length >= MAX_FORWARDS_PER_SESSION) {
    throw new ServerError(
      'CONFLICT',
      `session ${worktreeId.slice(0, 8)} already holds ${MAX_FORWARDS_PER_SESSION} forwarded ports`,
    )
  }

  const reserved = await reserveAvailablePort(containerPort, containerPort)

  // Re-check after the await: a concurrent request for the same port may
  // have won the race while we reserved — release ours and defer to it.
  const winner = getWorktreePorts(worktreeId).find((p) => p.containerPort === containerPort)
  if (winner || getWorktreePorts(worktreeId).length >= MAX_FORWARDS_PER_SESSION) {
    reserved.server.close()
    if (winner) return winner
    throw new ServerError(
      'CONFLICT',
      `session ${worktreeId.slice(0, 8)} already holds ${MAX_FORWARDS_PER_SESSION} forwarded ports`,
    )
  }

  const mapping = { containerPort: reserved.containerPort, hostPort: reserved.hostPort }
  const stop = startPortForwarders(relayTcpFactory(worktreeId), [reserved])

  const entry = forwarders.get(worktreeId)
  if (entry) {
    entry.stops.push(stop)
    entry.ports.push(mapping)
  } else {
    forwarders.set(worktreeId, { stops: [stop], ports: [mapping] })
  }

  // Cosmetic — a failed status-right refresh must not undo a live forward.
  await setWorktreeStatusRight(jobName, projectSlug, worktreeId, getWorktreePorts(worktreeId))
    .catch(() => {})

  return mapping
}
