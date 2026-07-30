import { listActiveSessions } from '#features/sessions/list'
import { listProjects } from '#features/projects/list'
import { listProvisioning } from '#features/sessions/provisioning'
import { listImageBuilds } from '#features/images/image-builds'
import { planUsageForSnapshot, codexPlanUsageForSnapshot } from '#features/auth/plan-usage'
import { serverLog } from '#log'
import { env } from '@yaac/shared/env'
import type { ServerEvent, ServerSnapshot } from '@yaac/shared/types'

/** Minimal surface the hub needs from a WebSocket connection. */
export interface WsLike {
  send(data: string): void
}

/**
 * Assemble the full server-state snapshot the webapp hydrates from. Same
 * data the equivalent HTTP reads return, gathered in one shot so a
 * connecting client needs zero follow-up round-trips.
 */
export async function buildSnapshot(): Promise<ServerSnapshot> {
  const [active, projects, planUsage, codexPlanUsage] = await Promise.all([
    listActiveSessions(),
    listProjects(),
    planUsageForSnapshot(),
    codexPlanUsageForSnapshot(),
  ])
  // A session with a provisioning entry is mid-create/mid-restart (or failed,
  // awaiting dismissal) — the row, not the session, is what clients should
  // render. The pod lists as an active session well before setup finishes
  // (pod Running + tmux up ≠ agent and init windows exist), so surfacing it
  // would make the webapp swap the placeholder for terminals that can't
  // attach yet. Suppressing the session until the create/restart route drops
  // the entry (on resolve) swaps row → ready session in one snapshot, and
  // keeps an id from ever appearing in both lists.
  const provisioning = listProvisioning()
  const provisioningIds = new Set(provisioning.map((p) => p.sessionId))
  return {
    sessions: active.sessions.filter((s) => !provisioningIds.has(s.sessionId)),
    stale: active.stale,
    projects,
    provisioning,
    gitAuthFailures: active.gitAuthFailures,
    imageBuilds: listImageBuilds(),
    planUsage,
    codexPlanUsage,
    forwardBindHost: env.forwardBind,
  }
}

/**
 * Fan-out hub for the `/events` stream. Holds every open connection and
 * pushes snapshots to all of them. `publishSnapshot` rebuilds the
 * snapshot and only broadcasts when it differs from the last one sent,
 * so an idle server's 5s tick produces no traffic.
 */
export class EventHub {
  private readonly conns = new Set<WsLike>()
  private lastSerialized: string | null = null
  private readonly build: () => Promise<ServerSnapshot>

  /** `build` defaults to the real snapshot; tests inject a fake. */
  constructor(build: () => Promise<ServerSnapshot> = buildSnapshot) {
    this.build = build
  }

  add(ws: WsLike): void {
    this.conns.add(ws)
  }

  remove(ws: WsLike): void {
    this.conns.delete(ws)
  }

  get size(): number {
    return this.conns.size
  }

  /** Send the current snapshot to a single connection (on connect). */
  async sendSnapshotTo(ws: WsLike): Promise<void> {
    const snapshot = await this.build()
    ws.send(serializeEvent({ type: 'snapshot', data: snapshot }))
  }

  /**
   * Rebuild the snapshot and broadcast it to all connections if it
   * changed since the last broadcast. No-op when nothing is connected.
   */
  async publishSnapshot(): Promise<void> {
    if (this.conns.size === 0) return
    let snapshot: ServerSnapshot
    try {
      snapshot = await this.build()
    } catch (err) {
      serverLog(`[server] events: snapshot build failed: ${String(err)}`)
      return
    }
    const event: ServerEvent = { type: 'snapshot', data: snapshot }
    const serialized = serializeEvent(event)
    if (serialized === this.lastSerialized) return
    this.lastSerialized = serialized
    this.broadcast(serialized)
  }

  private broadcast(serialized: string): void {
    for (const ws of this.conns) {
      try {
        ws.send(serialized)
      } catch (err) {
        serverLog(`[server] events: send failed, dropping conn: ${String(err)}`)
        this.conns.delete(ws)
      }
    }
  }
}

export function serializeEvent(event: ServerEvent): string {
  return JSON.stringify(event)
}
