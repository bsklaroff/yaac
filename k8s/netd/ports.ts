/**
 * Port allocation for an install's Envoy listener trio (https, http,
 * tunnel).
 *
 * Each install has one trio, shared by every redirected pod. Envoy picks
 * the egress target from the source pod IP (see envoy-config.ts), so
 * targets can change without moving a port, and conntrack's pinned DNAT
 * destinations stay valid for the life of the netd pod.
 *
 * Installs on one node share the port range (all run hostNetwork), so
 * netd tries slots in a hash-derived order and takes the first free trio.
 * This module is the pure arithmetic; the bind probe and persistence live
 * in listeners.ts.
 */

import crypto from 'node:crypto'

/**
 * The reserved node-local port window, in trio slots. The server passes it
 * via env (from proxy-constants.ts) so it matches the ports the workspace
 * NetworkPolicy admits.
 */
export interface ListenerRange {
  base: number
  slots: number
}

/**
 * Fallback when the env is absent (a hand-run netd). The DaemonSet
 * manifest test keeps it equal to NETD_LISTENER_PORT_BASE /
 * NETD_LISTENER_SLOTS.
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

/** A trio's ports in https, http, tunnel order. */
export function trioPorts(trio: ListenerTrio): number[] {
  return [trio.https, trio.http, trio.tunnel]
}

/**
 * Every slot in preference order: the slot hashed from the install
 * namespace first, then onward with wrap-around. Hashing keeps coexisting
 * installs (e.g. `yaac` and an e2e `yaac-test-<run-id>`) off each other's
 * first choice.
 */
export function slotPreference(
  installNamespace: string,
  range: ListenerRange = DEFAULT_LISTENER_RANGE,
): number[] {
  const digest = crypto.createHash('sha256').update(installNamespace).digest()
  const first = digest.readUInt32BE(0) % range.slots
  return Array.from({ length: range.slots }, (_, i) => (first + i) % range.slots)
}
