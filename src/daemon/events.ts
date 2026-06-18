import { listActiveSessions } from '@/lib/session/list'
import { listProjects } from '@/lib/project/list'
import { listProvisioning, removeProvisioning } from '@/daemon/provisioning'
import { daemonLog } from '@/daemon/log'
import type { DaemonEvent, DaemonSnapshot } from '@/shared/types'

/** Minimal surface the hub needs from a WebSocket connection. */
export interface WsLike {
  send(data: string): void
}

/**
 * Assemble the full daemon-state snapshot the webapp hydrates from. Same
 * data the equivalent HTTP reads return, gathered in one shot so a
 * connecting client needs zero follow-up round-trips.
 */
export async function buildSnapshot(): Promise<DaemonSnapshot> {
  const [active, projects] = await Promise.all([
    listActiveSessions(),
    listProjects(),
  ])
  // A provisioning entry whose session is now live has been superseded — drop
  // it (lazy cleanup) so the snapshot never carries both a provisioning row and
  // the real session for one id. Keeping it until this point means the row
  // stays visible through the whole startup grace window (no vanish/reappear).
  const activeIds = new Set(active.sessions.map((s) => s.sessionId))
  for (const p of listProvisioning()) if (activeIds.has(p.sessionId)) removeProvisioning(p.sessionId)
  const provisioning = listProvisioning().filter((p) => !activeIds.has(p.sessionId))
  return {
    sessions: active.sessions,
    stale: active.stale,
    projects,
    provisioning,
  }
}

/**
 * Fan-out hub for the `/events` stream. Holds every open connection and
 * pushes snapshots to all of them. `publishSnapshot` rebuilds the
 * snapshot and only broadcasts when it differs from the last one sent,
 * so an idle daemon's 5s tick produces no traffic.
 */
export class EventHub {
  private readonly conns = new Set<WsLike>()
  private lastSerialized: string | null = null
  private readonly build: () => Promise<DaemonSnapshot>

  /** `build` defaults to the real snapshot; tests inject a fake. */
  constructor(build: () => Promise<DaemonSnapshot> = buildSnapshot) {
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
    let snapshot: DaemonSnapshot
    try {
      snapshot = await this.build()
    } catch (err) {
      daemonLog(`[daemon] events: snapshot build failed: ${String(err)}`)
      return
    }
    const event: DaemonEvent = { type: 'snapshot', data: snapshot }
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
        daemonLog(`[daemon] events: send failed, dropping conn: ${String(err)}`)
        this.conns.delete(ws)
      }
    }
  }
}

export function serializeEvent(event: DaemonEvent): string {
  return JSON.stringify(event)
}
