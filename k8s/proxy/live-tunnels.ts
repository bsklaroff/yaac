/**
 * The tunnels each workspace holds open, and the admission each was accepted
 * under.
 *
 * The proxy checks the allowlist and picks the injection rules once per
 * tunnel, and once per plain-HTTP request, so either outlives the
 * registration it was accepted under. When a registration changes, every
 * one of that workspace's is re-admitted against it: one whose host is no
 * longer allowed, or whose admission (the rules and redirect it applies)
 * differs, is destroyed, and the client reconnects under the registration
 * as it is now. An unchanged admission keeps its tunnel, so widening an
 * allowlist drops nothing.
 *
 * A pure, dependency-free helper (like refresh-flight.ts) so it is
 * unit-testable by import — proxy.ts starts listeners at module load.
 */

import type { Readable, Writable } from 'node:stream'

/** A tunnel's client socket, or a plain-HTTP request's response. */
type Connection = Readable | Writable

interface LiveTunnel {
  connection: Connection
  hostname: string
  admission: string
}

export class LiveTunnels {
  private readonly byWorkspace = new Map<string, Set<LiveTunnel>>()

  /** Track `connection` until it closes. */
  add(workspaceId: string, connection: Connection, hostname: string, admission: string): void {
    let tunnels = this.byWorkspace.get(workspaceId)
    if (!tunnels) {
      tunnels = new Set()
      this.byWorkspace.set(workspaceId, tunnels)
    }
    const tunnel = { connection, hostname, admission }
    tunnels.add(tunnel)
    connection.once('close', () => {
      tunnels.delete(tunnel)
      if (tunnels.size === 0 && this.byWorkspace.get(workspaceId) === tunnels) {
        this.byWorkspace.delete(workspaceId)
      }
    })
  }

  /**
   * Destroy each of `workspaceId`'s tunnels whose admission `admit` now
   * answers differently — `null` for a host no longer allowed, or `admit`
   * itself `null` when the workspace is deregistered. Returns the hosts
   * dropped.
   */
  revoke(workspaceId: string, admit: ((hostname: string) => string | null) | null): string[] {
    const dropped: string[] = []
    for (const tunnel of this.byWorkspace.get(workspaceId) ?? []) {
      if (admit?.(tunnel.hostname) === tunnel.admission) continue
      dropped.push(tunnel.hostname)
      tunnel.connection.destroy()
    }
    return dropped
  }
}
