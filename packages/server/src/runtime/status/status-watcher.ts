import type { RuntimeHandle } from '#drivers/contract'
import { workspaceDriver } from '#drivers/driver'
import {
  agentDriver,
  dropAcpQueues,
  listWindows,
  type AgentConnectDeps,
  type AgentObservation,
  type DrivenWorkspace,
  type LiveAgent,
  type WatchedSession,
} from '#runtime/agents'
import {
  evictWorkspaceStatus,
  setAgentStatus,
  setLiveAgents,
  setWorkspaceStreamHealth,
  setWorkspaceWindows,
} from './status-store'
import { serverLog } from '#lib/log'
import { AGENT_MODES, type AgentMode } from '@yaac/shared/types'

/**
 * Per-workspace status watchers: live agent-driver connections per running
 * workspace, which (with the substrate watch) replace timer-driven status
 * probes.
 *
 * A workspace can run sessions of both modes, so its watcher holds one
 * connection per mode (a "lane"), each of which watches only its own mode's
 * sessions. The watcher does not know how a connection observes an agent:
 * it merges what the lanes report into the status store, and owns what both
 * modes share: respawn, backoff, the stream self-heal, and the window
 * listing, refreshed over a lane's tmux command channel when the stream
 * comes up, on every tmux window add, close or rename, and whenever the
 * live agents change (an agent exiting).
 *
 * A dropped connection only flips the store's health bit: status stays
 * sticky, and nothing here feeds the stale reaper.
 */

export type WatchedWorkspace = DrivenWorkspace

export interface StatusWatcherDeps {
  /**
   * The workspace's open sessions, injected from `main`: the drivers need
   * them, but reading the DB here would make `#runtime/status` depend on
   * `#db`.
   */
  sessions?: (workspace: WatchedWorkspace) => Promise<WatchedSession[]>
  /**
   * Test hook for the stream self-heal (see scheduleRespawn). Default: the
   * driver's `reviveStatusStream`.
   */
  reviveStreamd?: (jobName: string) => Promise<void>
  /** Heartbeat cadence over the open connection. Default 20s. */
  heartbeatIntervalMs?: number
  /** Init-command / heartbeat reply deadline. Default 10s. */
  commandTimeoutMs?: number
  /** First respawn delay after a connection death; doubles to the max. */
  respawnDelayMs?: number
  maxRespawnDelayMs?: number
  /** Test hook replacing the driver's real dial. */
  dial?: AgentConnectDeps['dial']
  log?: (msg: string) => void
}

/** One mode's connection and its retry state. */
interface Lane {
  readonly mode: AgentMode
  connection: { close(): void } | null
  /** Its tmux command channel while its stream is up. */
  send: ((cmd: string) => Promise<string>) | null
  up: boolean
  /** What it last reported running. */
  agents: LiveAgent[] | undefined
  /** Bumped on each teardown so late observations from a dead connection
   *  are ignored. */
  generation: number
  backoffMs: number
  respawnTimer: NodeJS.Timeout | null
  consecutiveFailures: number
}

export class WorkspaceStatusWatcher {
  private readonly lanes: Lane[]
  /** Bumped per window listing, so only the newest one is stored. */
  private listing = 0
  private stopped = false

  private readonly reviveStreamd: (jobName: string) => Promise<void>
  private readonly heartbeatIntervalMs: number
  private readonly commandTimeoutMs: number
  private readonly respawnDelayMs: number
  private readonly maxRespawnDelayMs: number
  private readonly log: (msg: string) => void

  constructor(readonly session: WatchedWorkspace, private readonly deps: StatusWatcherDeps = {}) {
    this.reviveStreamd = deps.reviveStreamd ?? ((jobName) => workspaceDriver().reviveStatusStream(jobName))
    this.heartbeatIntervalMs = deps.heartbeatIntervalMs ?? 20_000
    this.commandTimeoutMs = deps.commandTimeoutMs ?? 10_000
    this.respawnDelayMs = deps.respawnDelayMs ?? 1_000
    this.maxRespawnDelayMs = deps.maxRespawnDelayMs ?? 30_000
    this.log = deps.log ?? serverLog
    this.lanes = AGENT_MODES.map((mode) => ({
      mode,
      connection: null,
      send: null,
      up: false,
      agents: undefined,
      generation: 0,
      backoffMs: this.respawnDelayMs,
      respawnTimer: null,
      consecutiveFailures: 0,
    }))
  }

  start(): void {
    this.stopped = false
    for (const lane of this.lanes) this.connect(lane)
  }

  /**
   * Retire the watcher for good. A connection drop parks a chat's queued
   * messages for the reconnect; stopping is when no reconnect will come, so
   * they are discarded rather than sent if the workspace is resumed later.
   */
  stop(): void {
    this.stopped = true
    for (const lane of this.lanes) {
      if (lane.respawnTimer) clearTimeout(lane.respawnTimer)
      lane.respawnTimer = null
      this.teardown(lane)
    }
    dropAcpQueues(this.session.projectId, this.session.workspaceId)
  }

  private connect(lane: Lane): void {
    if (this.stopped) return
    const generation = ++lane.generation
    const sessions = this.deps.sessions
    lane.connection = agentDriver(lane.mode).connect(
      this.session,
      (obs) => this.onObservation(lane, generation, obs),
      {
        heartbeatIntervalMs: this.heartbeatIntervalMs,
        commandTimeoutMs: this.commandTimeoutMs,
        log: this.log,
        ...(this.deps.dial !== undefined ? { dial: this.deps.dial } : {}),
        ...(sessions !== undefined ? { sessions: () => sessions(this.session) } : {}),
      },
    )
  }

  private onObservation(lane: Lane, generation: number, obs: AgentObservation): void {
    if (generation !== lane.generation || this.stopped) return
    const { projectId, workspaceId } = this.session
    switch (obs.kind) {
      case 'up':
        lane.up = true
        lane.backoffMs = this.respawnDelayMs
        lane.consecutiveFailures = 0
        this.publishHealth()
        return
      case 'status':
        setAgentStatus(projectId, workspaceId, obs.handle, obs.status)
        return
      case 'live-agents':
        lane.agents = obs.agents
        this.publishAgents()
        this.refreshWindows()
        return
      case 'command-channel':
        lane.send = obs.send
        this.refreshWindows()
        return
      case 'windows-changed':
        this.refreshWindows()
        return
      case 'down':
        this.onConnectionDown(lane, generation, obs.reason)
        return
    }
  }

  /** Both lanes' agents, once each has listed them: before that, a gap
   *  would read as every agent of that mode exiting. */
  private publishAgents(): void {
    if (this.lanes.some((l) => l.agents === undefined)) return
    setLiveAgents(this.session.projectId, this.session.workspaceId, this.lanes.flatMap((l) => l.agents ?? []))
  }

  /** Healthy while every lane is up. */
  private publishHealth(): void {
    setWorkspaceStreamHealth(this.session.projectId, this.session.workspaceId, this.lanes.every((l) => l.up))
  }

  /** Best-effort: a failed listing keeps the last one, and the next window
   *  event or reconnect lists again. */
  private refreshWindows(): void {
    const send = this.lanes.find((l) => l.send !== null)?.send
    if (!send) return
    const listing = ++this.listing
    const { projectId, workspaceId } = this.session
    void listWindows(send).then((entries) => {
      if (listing === this.listing) setWorkspaceWindows(projectId, workspaceId, entries)
    }, () => { /* see above */ })
  }

  /** Idempotent per generation; flips health, never status. */
  private onConnectionDown(lane: Lane, generation: number, reason: string): void {
    if (generation !== lane.generation) return
    lane.generation++
    lane.consecutiveFailures++
    this.log(`[server] status-watcher ${this.session.workspaceId} (${lane.mode}): ${reason}`)
    this.teardown(lane)
    this.publishHealth()
    this.scheduleRespawn(lane)
  }

  private teardown(lane: Lane): void {
    lane.send = null
    lane.up = false
    lane.connection?.close()
    lane.connection = null
  }

  private scheduleRespawn(lane: Lane): void {
    if (this.stopped || lane.respawnTimer) return
    // Self-heal: repeated deaths may mean the in-workspace stream daemon is
    // down, which no new connection can fix, so ask the driver to revive it
    // (`reviveStatusStream`). Only every 3rd consecutive failure, so a proxy
    // outage does not trigger a storm of revives. Best-effort; a really dead
    // workspace is the reaper's.
    if (lane.consecutiveFailures > 0 && lane.consecutiveFailures % 3 === 0) {
      this.log(`[server] status-watcher ${this.session.workspaceId}: re-execing streamd (self-heal)`)
      void this.reviveStreamd(this.session.jobName).catch((err: unknown) => {
        this.log(`[server] status-watcher ${this.session.workspaceId}: streamd revive failed: ${String(err)}`)
      })
    }
    lane.respawnTimer = setTimeout(() => {
      lane.respawnTimer = null
      this.connect(lane)
    }, lane.backoffMs)
    lane.backoffMs = Math.min(lane.backoffMs * 2, this.maxRespawnDelayMs)
  }
}

/**
 * Keeps one `WorkspaceStatusWatcher` per running workspace. `sync` is driven
 * by the driver's workspace set: a new workspace (or a newly claimed spare)
 * gets a watcher; a vanished one has its watcher stopped and its store entry
 * evicted. Prewarmed spares run no agent, so they are not watched.
 */
export class StatusWatcherManager {
  private readonly watchers = new Map<string, WorkspaceStatusWatcher>()

  constructor(private readonly deps: StatusWatcherDeps = {}) {}

  get size(): number {
    return this.watchers.size
  }

  sync(workspaces: RuntimeHandle[]): void {
    const wanted = new Map<string, RuntimeHandle>()
    for (const p of workspaces) {
      if (!p.running || !p.workspaceId || !p.projectId || p.prewarmed) continue
      wanted.set(p.workspaceId, p)
    }
    for (const [workspaceId, watcher] of this.watchers) {
      if (wanted.has(workspaceId)) continue
      watcher.stop()
      this.watchers.delete(workspaceId)
      evictWorkspaceStatus(watcher.session.projectId, workspaceId)
    }
    for (const [workspaceId, workspace] of wanted) {
      if (this.watchers.has(workspaceId)) continue
      const watcher = new WorkspaceStatusWatcher({
        projectId: workspace.projectId,
        workspaceId,
        jobName: workspace.jobName,
      }, this.deps)
      watcher.start()
      this.watchers.set(workspaceId, watcher)
    }
  }

  stopAll(): void {
    for (const watcher of this.watchers.values()) watcher.stop()
    this.watchers.clear()
  }
}
