import { relayTcpFactory } from '#runtime/k8s/substrate'
import { startPortForwarders } from '#lib/port'
import type { ReservedPort } from '#lib/port'
import { registerWorktreeForwarders } from './port-forwarders'

/**
 * Take host ports the caller already bound and put live relays behind
 * them, held for the worktree's lifetime.
 *
 * The launch path's half of what `provisionWorktreeForwarders` does for a
 * server restart, and separate because the reservation cannot happen here:
 * the ports are bound before the pod exists — nothing else guarantees they
 * are still free once it does — and a launch that gives up closes them
 * itself rather than ever reaching this. No status-right refresh either,
 * since the launch stamped the bar from these same reservations.
 */
export function adoptWorktreeForwarders(
  worktreeId: string,
  ports: ReservedPort[],
): void {
  if (ports.length === 0) return
  const stop = startPortForwarders(relayTcpFactory(worktreeId), ports)
  registerWorktreeForwarders(worktreeId, stop, ports)
}
