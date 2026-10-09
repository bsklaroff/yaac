import {
  listActiveWorkspaces,
  listDraftWorkspaces,
  listHeldWorkspaces,
  listProvisioning,
  listQueuedWorkspaces,
  listWorkspaceGroups,
} from '#domain/workspaces'
import { countStoppedWorkspaces } from '#db'
import { listProjects } from '#domain/projects'
import { workspaceDriver } from '#drivers/driver'
import { planUsageForSnapshot } from '#domain/auth'
import { serverLog } from '#log'
import { env } from '@yaac/shared/env'
import type { ServerEvent, ServerSnapshot } from '@yaac/shared/types'

/** Minimal surface the hub needs from a WebSocket connection. */
export interface WsLike {
  send(data: string): void
}

/**
 * Assemble the full server-state snapshot the webapp hydrates from: the same
 * data the HTTP reads return, in one message.
 */
export async function buildSnapshot(): Promise<ServerSnapshot> {
  // Shared by the project and group summaries.
  const stoppedCounts = countStoppedWorkspaces()
  const [
    active, workspaceGroups, projects, usage, queuedWorkspaces, heldWorkspaces, draftWorkspaces,
  ] = await Promise.all([
    listActiveWorkspaces(),
    listWorkspaceGroups(undefined, stoppedCounts),
    listProjects(stoppedCounts),
    planUsageForSnapshot(),
    listQueuedWorkspaces(),
    listHeldWorkspaces(),
    listDraftWorkspaces(),
  ])
  const imageBuilds = workspaceDriver().listImageBuilds()
  // A workspace with a provisioning entry is mid-create or mid-restart (or
  // failed, awaiting dismissal), so clients render the provisioning row
  // instead. The workspace lists as running before its agent and init windows
  // exist; hiding it until the route drops the entry swaps the row for a ready
  // workspace in one snapshot, and no id appears in both lists. A spare
  // claimed by a create is hidden the same way, and so is a held row for a
  // workspace mid-restart, which keeps its stop until the restart succeeds.
  const provisioning = listProvisioning()
  const hidden = new Set(provisioning.flatMap((p) => [p.workspaceId, p.claimedId]))
  return {
    driver: workspaceDriver().kind,
    workspaces: active.workspaces.filter((w) => !hidden.has(w.workspaceId)),
    workspaceGroups,
    stale: active.stale,
    projects,
    provisioning,
    queuedWorkspaces,
    heldWorkspaces: heldWorkspaces.filter((w) => !hidden.has(w.workspaceId)),
    draftWorkspaces,
    gitAuthFailures: active.gitAuthFailures,
    imageBuilds,
    ...usage,
    forwardBindHost: env.forwardBind,
  }
}

/**
 * Fan-out hub for the `/events` stream: holds every open connection and
 * pushes snapshots to them. It is the only consumer of `#notify`, which every
 * store the snapshot reads emits on change (docs/layered-server.md).
 * Snapshots are broadcast only when they differ from the last one sent.
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
    ws.send(JSON.stringify({ type: 'snapshot', data: snapshot } satisfies ServerEvent))
  }

  /**
   * Rebuild the snapshot and broadcast it if it changed since the last
   * broadcast. No-op when nothing is connected.
   *
   * Builds never run concurrently: two in flight could resolve out of order
   * and leave clients (and `lastSerialized`) on stale state until the next
   * notify. A publish that arrives mid-build makes the running build loop
   * once more, so a burst of notifies coalesces instead of costing one
   * rebuild each.
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
    const serialized = JSON.stringify({ type: 'snapshot', data: snapshot } satisfies ServerEvent)
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
