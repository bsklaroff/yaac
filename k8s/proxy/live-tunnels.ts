/**
 * Tracks each workspace's open tunnels and plain-HTTP requests, with the
 * admission (allowlist result plus injection rules) each was accepted under.
 *
 * Admission is decided once per connection, so a connection can outlive a
 * registration change. On a change, every connection is re-admitted; any
 * whose host is no longer allowed or whose admission differs is destroyed,
 * and the client reconnects. Unchanged admissions keep their connection, so
 * widening an allowlist drops nothing.
 *
 * Dependency-free so tests can import it; proxy.ts starts listeners at load.
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
