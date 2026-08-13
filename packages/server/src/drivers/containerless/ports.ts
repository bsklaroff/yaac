import { MAX_SURFACED_PORTS, isForwardablePort } from '#drivers/shared'
import { descendantPids, listeningPorts } from './host'
import { listWorkspaces, tmuxPidOf } from './registry'
import type { PortMapping } from '@yaac/shared/types'

/**
 * Which ports each workspace is listening on.
 *
 * The pod driver has to RELAY a port: a listener inside a pod is reachable
 * from nowhere until something binds a host port and forwards it. Here the
 * workspace's processes bind host ports themselves, so a detected listener
 * is already reachable and the mapping is the identity — which is why these
 * surface as `forwardedPorts` (links the user can click) and
 * `unforwardedPorts` is always empty. There is no "forward this" action
 * because there is nothing left to do.
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

const ports = new Map<string, number[]>()
let timer: NodeJS.Timeout | null = null

/** Test-only: drop all detector state. */
export function _resetPortsForTests(): void {
  ports.clear()
}

/** See `WorktreeDriver.forwardedPorts` — the identity mappings for whatever
 *  the last sweep saw this workspace listening on. */
export function workspacePorts(worktreeId: string): PortMapping[] {
  return (ports.get(worktreeId) ?? []).map((p) => ({ containerPort: p, hostPort: p }))
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
      .filter(isForwardablePort)
      .slice(0, MAX_SURFACED_PORTS)
    const before = ports.get(handle.workspaceId) ?? []
    if (before.length !== found.length || before.some((p, i) => p !== found[i])) {
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
