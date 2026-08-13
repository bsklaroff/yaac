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

import { relayTcpFactory, podExec } from '#drivers/k8s/substrate'
import { notifyWorktreeListChanged } from '#notify'
import { reserveAvailablePort, startPortForwarders } from '#lib/port'
import { ServerError } from '@yaac/shared/errors'
import { buildStatusRight, setStatusRightCmd } from '#lib/status-right'
import type { PortMapping } from '@yaac/shared/types'

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
  } else {
    forwarders.set(worktreeId, { stops: [stop], ports: mapped })
  }
  // This registry is what `forwardedPorts` reads, so it announces its own
  // changes. The startup restore fires this before any client connects,
  // where publishing is a no-op.
  notifyWorktreeListChanged()
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
  // Covers stopAllWorktreeForwarders too, which runs this per worktree.
  notifyWorktreeListChanged()
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

/** Restate the worktree's bar from the forwarders it now holds. The restore
 *  path has its own, over the contract; this one rides the driver's exec
 *  because it is already inside the driver. */
async function refreshStatusRight(
  jobName: string,
  projectSlug: string,
  worktreeId: string,
): Promise<void> {
  await podExec(
    jobName,
    setStatusRightCmd(buildStatusRight(projectSlug, worktreeId, getWorktreePorts(worktreeId))),
  )
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
  // Before the cosmetic refresh below: the forward is live now, and the
  // snapshot is what moves the port out of `unforwardedPorts`.
  notifyWorktreeListChanged()

  // Cosmetic — a failed status-right refresh must not undo a live forward.
  await refreshStatusRight(jobName, projectSlug, worktreeId)
    .catch(() => { /* cosmetic */ })

  return mapping
}
