/**
 * In-memory registry of the host ports each workspace's forwards are
 * offered at, keyed by workspaceId. Declared when a workspace starts,
 * dropped when it is deleted or reaped.
 *
 * Nothing here binds a port. The server runs as a pod, so a port it bound
 * would be unreachable from the user's machine; a client (`yaac forward`
 * or the desktop app) binds each mapping and tunnels connections back
 * (docs/port-forward-tunnel.md). This module also allocates host ports, so
 * two workspaces asking for 3000 get different answers.
 *
 * A workspace's entry merges the create/restore batch with any single-port
 * additions (`addWorkspaceForwarder`).
 */

import { k8sWorkspacePaths, podExec } from '#drivers/k8s/substrate'
import { notifyWorkspaceListChanged } from '#notify'
import { ServerError } from '@yaac/shared/errors'
import { buildStatusRight, setStatusRightCmd } from '#lib/status-right'
import type { PortForwardConfig, PortMapping } from '@yaac/shared/types'

/** Cap on forwards per workspace, so a flood of forward-port actions can't
 *  exhaust host ports or streamd's stream limit. */
export const MAX_FORWARDS_PER_SESSION = 32

/** Highest host port the walk will climb to before giving up. */
const MAX_HOST_PORT = 65535

const forwarders = new Map<string, PortMapping[]>()

/** Every host port already promised, across every workspace. Recomputed
 *  from `forwarders` on each call rather than kept as a second copy. */
function allocated(): Set<number> {
  const taken = new Set<number>()
  for (const ports of forwarders.values()) {
    for (const { hostPort } of ports) taken.add(hostPort)
  }
  return taken
}

/**
 * The first host port at or above `startPort` not yet promised. Only this
 * server's own promises are checked: the port is bound on the client's
 * machine, which the server cannot see, so a clash there shows up as the
 * client failing to bind.
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

/** Record mappings against a workspace, appending to what it already
 *  holds: create's batch can race a forward-port request, since the pod's
 *  dev servers are detectable before create returns. Announces the change,
 *  since `forwardedPorts` reads this registry. */
function record(workspaceId: string, ports: ReadonlyArray<PortMapping>): void {
  const entry = forwarders.get(workspaceId)
  if (entry) {
    entry.push(...ports.map(({ containerPort, hostPort }) => ({ containerPort, hostPort })))
  } else {
    forwarders.set(workspaceId, ports.map(({ containerPort, hostPort }) => ({ containerPort, hostPort })))
  }
  notifyWorkspaceListChanged()
}

/**
 * Declare the forwards a workspace's config asks for and return the host
 * port each is offered at (see `WorkspaceDriver.declareForwards`). Runs
 * before launch, because the ports are shown in the workspace's tmux
 * status bar. Each entry is recorded before the next is allocated, so two
 * entries in one config never share a host port.
 */
export function declareWorkspaceForwards(
  workspaceId: string,
  forwards: ReadonlyArray<PortForwardConfig>,
): PortMapping[] {
  if (forwards.length === 0) return []
  const mappings: PortMapping[] = []
  for (const { containerPort, hostPortStart } of forwards) {
    const hostPort = allocateHostPort(hostPortStart)
    const mapping = { containerPort, hostPort }
    mappings.push(mapping)
    record(workspaceId, [mapping])
  }
  return mappings
}

/**
 * The host-to-container port mappings a workspace is offered at, or empty.
 * Feeds `forwardedPorts` on workspace-list entries, which the webapp and
 * every client forwarder read.
 */
export function getWorkspacePorts(workspaceId: string): PortMapping[] {
  return forwarders.get(workspaceId) ?? []
}

export function stopWorkspaceForwarders(workspaceId: string): void {
  if (!forwarders.delete(workspaceId)) return
  notifyWorkspaceListChanged()
}

/** Forget every declaration. Called on server shutdown and by the api
 *  tests between cases. */
export function stopAllWorkspaceForwarders(): void {
  for (const workspaceId of [...forwarders.keys()]) {
    stopWorkspaceForwarders(workspaceId)
  }
}

/** Rewrite the workspace's tmux status-right from its current forwards. */
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
 * Offer one more container port on a running workspace (the webapp's
 * "forward this port" action). Allocates a host port starting at the
 * container port and refreshes the tmux status bar; a failed refresh is
 * ignored. Idempotent per container port. Allocation and record happen in
 * one synchronous step, so concurrent requests can't get the same port.
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

  const mapping = { containerPort, hostPort: allocateHostPort(containerPort) }
  record(workspaceId, [mapping])

  await refreshStatusRight(jobName, projectSlug, workspaceId)
    .catch(() => { /* cosmetic */ })

  return mapping
}
