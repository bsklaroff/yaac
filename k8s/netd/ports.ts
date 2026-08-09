/**
 * Listener-port allocation for this install's Envoy trio.
 *
 * ONE trio per install — https / http / tunnel — shared by every pod netd
 * redirects, whatever egress target that pod resolves to. The target is
 * chosen inside Envoy by matching the connection's source pod IP against a
 * filter chain (see envoy-config.ts), not by which port the packet landed
 * on, so adding or removing a target never moves a port. That is what
 * makes an in-flight flow safe: conntrack pins a flow's DNAT destination
 * on its first packet, and the port that destination names is now fixed
 * for the whole life of the netd pod.
 *
 * The range is still node-local and shared between coexisting installs
 * (they all run hostNetwork), so the slot is CHOSEN, not assumed: netd
 * probes from a hash-derived preference and takes the first trio nothing
 * else holds. Three ports per install rather than three per target makes a
 * collision vanishingly unlikely to begin with, and the probe plus the
 * Envoy listener gate (netd.ts) turn the residual case into a logged
 * retry instead of two installs silently sharing a socket.
 *
 * Pure here: the slot preference order and the port arithmetic. The bind
 * probe and the persistence that keeps a restarted netd on the same trio
 * live in listeners.ts.
 */

import crypto from 'node:crypto'

/**
 * The reserved node-local port window, as trio slots. Passed in from the
 * server (proxy-constants.ts) via env so the range has ONE definition —
 * the worktree NetworkPolicy admits exactly these ports, so a netd that
 * disagreed with the policy would bind listeners nothing may reach.
 */
export interface ListenerRange {
  base: number
  slots: number
}

/**
 * Fallback when the env is absent (a hand-run netd). Kept in sync with
 * NETD_LISTENER_PORT_BASE / NETD_LISTENER_SLOTS by the DaemonSet manifest
 * test, which asserts the manifest passes these exact values.
 */
export const DEFAULT_LISTENER_RANGE: ListenerRange = { base: 15100, slots: 300 }

/** The three listener ports serving one install. */
export interface ListenerTrio {
  https: number
  http: number
  tunnel: number
}

/** The trio occupying `slot`. */
export function trioForSlot(slot: number, range: ListenerRange = DEFAULT_LISTENER_RANGE): ListenerTrio {
  const base = range.base + slot * 3
  return { https: base, http: base + 1, tunnel: base + 2 }
}

/** A trio's ports, in leg order — what the bind probe and the gate check. */
export function trioPorts(trio: ListenerTrio): number[] {
  return [trio.https, trio.http, trio.tunnel]
}

/**
 * Every slot, ordered by preference: the install's hashed slot first, then
 * forward with wrap.
 *
 * Hashing the install namespace (rather than starting at 0) is what keeps
 * two installs off each other's first choice without either knowing the
 * other exists — the real `yaac` install and an ephemeral e2e
 * `yaac-test-<run-id>` land on unrelated slots.
 */
export function slotPreference(
  installNamespace: string,
  range: ListenerRange = DEFAULT_LISTENER_RANGE,
): number[] {
  const digest = crypto.createHash('sha256').update(installNamespace).digest()
  const first = digest.readUInt32BE(0) % range.slots
  return Array.from({ length: range.slots }, (_, i) => (first + i) % range.slots)
}
