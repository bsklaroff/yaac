/**
 * Process-local registry of the forwards each workspace is offered at,
 * keyed by workspaceId. The server declares them when a workspace starts
 * (see `createWorkspace`) and must drop them when the workspace is deleted
 * or reaped; this module is the handoff point.
 *
 * A DECLARATION, not a listener. Nothing here binds a host port: the
 * server runs as a pod, so a port it bound would be on the pod's loopback
 * and reachable from nowhere the user is. The listener lives in a client
 * — `yaac forward`, or the desktop app as the resident forwarder — which
 * reads these mappings off the snapshot, binds them itself, and tunnels
 * each accepted connection back over `/forward/attach`.
 *
 * That makes this module the ALLOCATOR too. Binding used to disambiguate
 * two workspaces of one project both asking for 3000 — whoever bound
 * first won and the second walked up. With nothing bound, the walk has to
 * read a ledger instead, which is what `allocated` is.
 *
 * A workspace's entry accumulates declarations: the create/restore batch
 * plus any reactive single-port appends (addWorkspaceForwarder), merged so
 * neither can drop the other. The server-restart restore pass guards with
 * hasWorkspaceForwarders before provisioning, so it never double-declares.
 */

import { k8sWorkspacePaths, podExec } from '#drivers/k8s/substrate'
import { notifyWorkspaceListChanged } from '#notify'
import { ServerError } from '@yaac/shared/errors'
import { buildStatusRight, setStatusRightCmd } from '#lib/status-right'
import type { PortForwardConfig, PortMapping } from '@yaac/shared/types'

/** Ceiling on live forwards per workspace — bounds a hostile flood of
 *  forward-port actions (and keeps well under streamd's stream cap). */
export const MAX_FORWARDS_PER_SESSION = 32

/** Highest host port the walk will climb to before giving up. */
const MAX_HOST_PORT = 65535

const forwarders = new Map<string, PortMapping[]>()

/** Every host port already promised, across every workspace. Derived
 *  state, recomputed rather than kept in step: the map IS the record, and
 *  a second copy of it is a second thing to get wrong. */
function allocated(): Set<number> {
  const taken = new Set<number>()
  for (const ports of forwarders.values()) {
    for (const { hostPort } of ports) taken.add(hostPort)
  }
  return taken
}

/**
 * The first host port at or above `startPort` nothing else was promised.
 *
 * Only this server's own promises are consulted — what any other process
 * on the user's machine holds is unknowable from inside a pod, and would
 * be the wrong question anyway: the machine that binds is the client's,
 * which may not even be this one. A collision there surfaces where it can
 * be seen, as the client's listener failing to bind.
 */
function allocateHostPort(startPort: number): number {
  const taken = allocated()
  for (let port = startPort; port <= MAX_HOST_PORT; port++) {
    if (!taken.has(port)) return port
  }
  throw new ServerError(
    'CONFLICT',
    `no host port available at or above ${startPort}`,
  )
}

/** Record mappings against a workspace, merging with whatever it already
 *  holds — create's batch can race a reactive append from the forward-port
 *  route (the pod is Running, and its dev servers detectable, well before
 *  create returns), and dropping either side would lose a live offer. */
function record(workspaceId: string, ports: ReadonlyArray<PortMapping>): void {
  const entry = forwarders.get(workspaceId)
  if (entry) {
    entry.push(...ports.map(({ containerPort, hostPort }) => ({ containerPort, hostPort })))
  } else {
    forwarders.set(workspaceId, ports.map(({ containerPort, hostPort }) => ({ containerPort, hostPort })))
  }
  // This registry is what `forwardedPorts` reads, so it announces its own
  // changes. The startup restore fires this before any client connects,
  // where publishing is a no-op.
  notifyWorkspaceListChanged()
}

/**
 * Declare the forwards a workspace's config asks for, answering the host
 * port each is offered at (see `WorkspaceDriver.declareForwards`).
 *
 * Runs before the workspace launches, because the answer is stamped into
 * the workspace's own tmux status bar — which is also why it allocates
 * rather than merely echoing the config: two workspaces of one project
 * both asking for 3000 must not both be told 3000.
 */
export function declareWorkspaceForwards(
  workspaceId: string,
  forwards: ReadonlyArray<PortForwardConfig>,
): PortMapping[] {
  if (forwards.length === 0) return []
  const mappings: PortMapping[] = []
  for (const { containerPort, hostPortStart } of forwards) {
    // Inside the loop, so two entries of ONE config cannot be handed the
    // same number: each is recorded before the next is allocated.
    const hostPort = allocateHostPort(hostPortStart)
    const mapping = { containerPort, hostPort }
    mappings.push(mapping)
    record(workspaceId, [mapping])
  }
  return mappings
}

/**
 * Host↔container mappings a workspace is offered at, empty when none are
 * declared. Feeds the `forwardedPorts` field of workspace-list entries (and
 * thus the webapp snapshot and every client forwarder) — the registry is
 * the server's only record of which host ports a workspace was promised.
 */
export function getWorkspacePorts(workspaceId: string): PortMapping[] {
  return forwarders.get(workspaceId) ?? []
}

export function stopWorkspaceForwarders(workspaceId: string): void {
  if (!forwarders.delete(workspaceId)) return
  // Covers stopAllWorkspaceForwarders too, which runs this per workspace.
  notifyWorkspaceListChanged()
}

export function hasWorkspaceForwarders(workspaceId: string): boolean {
  return forwarders.has(workspaceId)
}

/**
 * Forget every declaration. Called from the server's shutdown handler, and
 * by the api tests between cases — the map outlives any one workspace, so
 * the host ports it has promised stay promised until something says
 * otherwise.
 */
export function stopAllWorkspaceForwarders(): void {
  for (const workspaceId of [...forwarders.keys()]) {
    stopWorkspaceForwarders(workspaceId)
  }
}

/** Restate the workspace's bar from the forwards it now holds. The restore
 *  path has its own, over the contract; this one rides the driver's exec
 *  because it is already inside the driver. */
async function refreshStatusRight(
  jobName: string,
  projectSlug: string,
  workspaceId: string,
): Promise<void> {
  await podExec(
    jobName,
    setStatusRightCmd(
      buildStatusRight(projectSlug, workspaceId, getWorkspacePorts(workspaceId)),
      k8sWorkspacePaths().tmuxSock,
    ),
  )
}

/**
 * Offer ONE additional container port on a running workspace — the reactive
 * path behind the webapp's "forward this port" action, appended to
 * whatever the workspace already holds (creating its registry entry when it
 * has none). Allocates a host port starting at the container port itself
 * and refreshes tmux status-right so the bar matches the live set.
 * Idempotent per container port.
 */
export async function addWorkspaceForwarder(
  projectSlug: string,
  workspaceId: string,
  jobName: string,
  containerPort: number,
): Promise<PortMapping> {
  const existing = getWorkspacePorts(workspaceId).find((p) => p.containerPort === containerPort)
  if (existing) return existing
  if (getWorkspacePorts(workspaceId).length >= MAX_FORWARDS_PER_SESSION) {
    throw new ServerError(
      'CONFLICT',
      `session ${workspaceId.slice(0, 8)} already holds ${MAX_FORWARDS_PER_SESSION} forwarded ports`,
    )
  }

  // Allocation and record are one synchronous step, so a concurrent
  // request for the same port cannot slip between them and be handed the
  // same host port — the race the bound-socket version had to unwind
  // afterwards simply cannot start.
  const mapping = { containerPort, hostPort: allocateHostPort(containerPort) }
  record(workspaceId, [mapping])

  // Cosmetic — a failed status-right refresh must not undo a live offer.
  await refreshStatusRight(jobName, projectSlug, workspaceId)
    .catch(() => { /* cosmetic */ })

  return mapping
}
