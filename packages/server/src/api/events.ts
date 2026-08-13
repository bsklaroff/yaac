import { listActiveWorktrees, listProvisioning, listWorktreeGroups } from '#domain/worktrees'
import { listProjects } from '#domain/projects'
import { worktreeDriver } from '#drivers/driver'
import { planUsageForSnapshot, codexPlanUsageForSnapshot } from '#domain/auth'
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
  const [active, worktreeGroups, projects, planUsage, codexPlanUsage] = await Promise.all([
    listActiveWorktrees(),
    listWorktreeGroups(),
    listProjects(),
    planUsageForSnapshot(),
    codexPlanUsageForSnapshot(),
  ])
  const imageBuilds = worktreeDriver().listImageBuilds()
  // A worktree with a provisioning entry is mid-create/mid-restart (or
  // failed, awaiting dismissal) — the row, not the worktree, is what clients
  // should render. The pod lists as running well before setup finishes
  // (pod Running + tmux up ≠ agent and init windows exist), so surfacing it
  // would make the webapp swap the placeholder for terminals that can't
  // attach yet. Suppressing the worktree until the create/restart route drops
  // the entry (on resolve) swaps row → ready worktree in one snapshot, and
  // keeps an id from ever appearing in both lists.
  const provisioning = listProvisioning()
  const provisioningIds = new Set(provisioning.map((p) => p.worktreeId))
  return {
    driver: worktreeDriver().kind,
    worktrees: active.worktrees.filter((w) => !provisioningIds.has(w.worktreeId)),
    worktreeGroups,
    stale: active.stale,
    // `worktreeCount` is what ProjectSummary still calls it on the wire.
    projects: projects.map(({ worktreeCount, ...p }) => ({ ...p, worktreeCount: worktreeCount })),
    provisioning,
    gitAuthFailures: active.gitAuthFailures,
    imageBuilds,
    planUsage,
    codexPlanUsage,
    forwardBindHost: env.forwardBind,
  }
}

/**
 * Fan-out hub for the `/events` stream. Holds every open connection and
 * pushes snapshots to all of them.
 *
 * The sole consumer of `#notify`, which every store the snapshot reads
 * emits on when it changes (docs/layered-server.md). `publishSnapshot`
 * rebuilds and broadcasts only when the result differs from the last one
 * sent, so a notify for something a client cannot see costs a rebuild and
 * no traffic — and an idle server, having nothing to notify about,
 * rebuilds nothing at all.
 */
export class EventHub {
  private readonly conns = new Set<WsLike>()
  private lastSerialized: string | null = null
  private readonly build: () => Promise<ServerSnapshot>
  /** A build is running; concurrent publishes fold into `publishAgain`. */
  private publishing = false
  private publishAgain = false

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
   *
   * Builds are serialized, never concurrent. A build is several awaited
   * substrate reads long, so two in flight can resolve out of order: the
   * newer one broadcasts, then the older overwrites both the wire and
   * `lastSerialized` with state that has already been superseded. Nothing
   * would repair that — the diff now believes clients hold the stale
   * snapshot — until some later mutation happens to notify. A publish that
   * arrives mid-build therefore asks the running one to go round again
   * rather than starting a second, which also means a notification storm
   * costs one rebuild plus one final catch-up, not one rebuild per notify.
   */
  async publishSnapshot(): Promise<void> {
    if (this.publishing) {
      this.publishAgain = true
      return
    }
    this.publishing = true
    try {
      do {
        this.publishAgain = false
        await this.buildAndBroadcast()
      } while (this.publishAgain)
    } finally {
      this.publishing = false
    }
  }

  private async buildAndBroadcast(): Promise<void> {
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
