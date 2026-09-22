import net from 'node:net'
import { MAX_SURFACED_PORTS, isForwardablePort } from '#drivers/shared'
import { descendantPids, listeningPorts, type Listener } from './host'
import { listWorkspaces, tmuxPidOf } from './registry'
import type { Duplex } from 'node:stream'
import type { PortMapping } from '@yaac/shared/types'

/**
 * Which ports each workspace is listening on.
 *
 * The pod driver has to RELAY a port: a listener inside a pod is reachable
 * from nowhere until something binds a host port and forwards it. Here the
 * workspace's processes bind host ports themselves, so a detected listener
 * is already reachable ON THIS MACHINE and the mapping is the identity —
 * which is why these surface as `forwardedPorts` (links the user can click)
 * and `unforwardedPorts` is always empty. There is no "forward this" action
 * because there is nothing left to do.
 *
 * A client on another machine is a different matter: to it the server
 * host's loopback is as unreachable as a pod's, and the tunnel is the same
 * answer — bind the mapping there, dial the port here (`dialWorkspacePort`).
 *
 * That also means the port a config's `portForward` asks for is simply the
 * port the dev server binds; the create path skips its host-port
 * reservation entirely rather than racing the workspace for it.
 *
 * A poll rather than an edge, and honestly so: the pod driver's detector is
 * a poll too (its stream daemon samples `/proc/net/tcp` on a timer), and no
 * portable "a process began listening" event exists. Only running
 * workspaces are scanned.
 */

const POLL_MS = 3_000

const ports = new Map<string, Listener[]>()
let timer: NodeJS.Timeout | null = null

/** Test-only: drop all detector state. */
export function _resetPortsForTests(): void {
  ports.clear()
}

/** See `WorktreeDriver.forwardedPorts` — the identity mappings for whatever
 *  the last sweep saw this workspace listening on. */
export function workspacePorts(worktreeId: string): PortMapping[] {
  return (ports.get(worktreeId) ?? []).map(({ port }) => ({ containerPort: port, hostPort: port }))
}

/** One sweep over every running workspace. Exported so a test can drive it
 *  without waiting out the timer. */
export async function sweepPorts(): Promise<boolean> {
  let changed = false
  for (const handle of listWorkspaces()) {
    if (!handle.running) {
      if (ports.delete(handle.workspaceId)) changed = true
      continue
    }
    const root = tmuxPidOf(handle.workspaceId)
    if (root === undefined) continue
    const found = (await listeningPorts(await descendantPids([root])))
      .filter((l) => isForwardablePort(l.port))
      .slice(0, MAX_SURFACED_PORTS)
    const before = ports.get(handle.workspaceId) ?? []
    if (
      before.length !== found.length
      || before.some((l, i) => l.port !== found[i].port || l.host !== found[i].host)
    ) {
      ports.set(handle.workspaceId, found)
      changed = true
    }
  }
  return changed
}

/** Start the sweep. `onChange` fires only when the surfaced set really
 *  moved, so an idle host pushes no snapshots. */
export function startPortSweep(onChange: () => void): void {
  if (timer) return
  timer = setInterval(() => {
    void sweepPorts().then((changed) => { if (changed) onChange() })
  }, POLL_MS)
  // Never hold the process open for a port scan.
  timer.unref?.()
}

export function stopPortSweep(): void {
  if (timer) clearInterval(timer)
  timer = null
}

/** Drop a workspace's ports when it goes away. */
export function forgetPorts(worktreeId: string): void {
  ports.delete(worktreeId)
}

/**
 * See `WorktreeDriver.dialPort`: one TCP connection onto a port the
 * workspace is listening on, for a forwarder whose listener is on another
 * machine.
 *
 * Only a LISTENER the sweep has surfaced, dialled at the address it is
 * bound to. What keeps every other service on this host out of reach is
 * the sweep's scope — it walks the worktree's own process tree, so the
 * set is an allowlist of that tree's listeners with the sensitive-port
 * denylist on top — and dialling the recorded address rather than a
 * guessed loopback is what keeps a stranger on the OTHER loopback family
 * of the same port number from answering in the worktree's place. The
 * pod driver dials anything, because a pod is a sandbox; this host is
 * the user's machine. (A yaac-dev worktree's inner `yaac server` IS in
 * its tree, so that port surfaces and is dialable — as under k8s.)
 *
 * The set is the LAST sweep's, not a live one: a port the worktree
 * released and something else re-bound stays dialable for up to the
 * sweep interval. Re-validating per dial would cost an lsof per TCP
 * connection, and the window is bounded by `POLL_MS`.
 */
export function dialWorkspacePort(worktreeId: string, port: number): Promise<Duplex> {
  const listener = (ports.get(worktreeId) ?? []).find((l) => l.port === port)
  if (!listener) {
    return Promise.reject(new Error(`port ${String(port)} is not one this worktree is listening on`))
  }
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: listener.host, port })
    // Paused, as the contract requires: the tunnel attaches its reader
    // before resuming, so nothing the far end writes on connect is lost.
    socket.pause()
    socket.once('connect', () => resolve(socket))
    // Stays attached after connect (a no-op reject), so an error in the gap
    // before the tunnel adds its own listener is never an uncaught one.
    socket.once('error', reject)
  })
}
