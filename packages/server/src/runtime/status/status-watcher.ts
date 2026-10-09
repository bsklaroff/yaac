import type { RuntimeHandle } from '#drivers/contract'
import { workspaceDriver } from '#drivers/driver'
import {
  agentDriver,
  dropAcpQueues,
  type AgentConnectDeps,
  type AgentObservation,
  type DrivenWorkspace,
} from '#runtime/agents'
import { listTerminals } from '#runtime/terminals'
import {
  evictWorkspaceStatus,
  setAgentStatus,
  setLiveAgents,
  setWorkspaceStreamHealth,
  setWorkspaceTerminals,
} from './status-store'
import { serverLog } from '#log'
import type { AgentMode, AgentTool, PermissionMode } from '@yaac/shared/types'

/**
 * Per-workspace status watchers: one live agent-driver connection per
 * running workspace, which (with the substrate watch) replaces timer-driven
 * status probes.
 *
 * The watcher does not know how a connection observes an agent. It picks a
 * driver from the workspace's mode (`#runtime/agents`), feeds observations
 * into the status store, and owns what both modes share: respawn, backoff,
 * the stream self-heal, and the terminal listing, refreshed over the
 * driver's read-only channel when the stream comes up and on every tmux
 * window add, close or rename.
 *
 * A dropped connection only flips the store's health bit: status stays
 * sticky, and nothing here feeds the stale reaper.
 */

export interface WatchedWorkspace extends DrivenWorkspace {
  /** Which driver observes this workspace (its recorded mode). */
  mode: AgentMode
}

export interface StatusWatcherDeps {
  /**
   * The workspace's recorded conversations, injected from `main`: the ACP
   * driver needs them, but reading the DB here would make `#runtime/status`
   * depend on `#domain/workspaces`.
   */
  recordedSessions?: (session: WatchedWorkspace) => Promise<Array<{ handle: string; agentSessionId: string }>>
  /**
   * The workspace's permission posture, injected like `recordedSessions`;
   * the ACP driver tells its adapter which posture to use.
   */
  permissionMode?: (session: WatchedWorkspace) => Promise<PermissionMode | undefined>
  /** The workspace's launch model for a tool, injected like
   *  `recordedSessions` (see `AgentConnectDeps.launchModel`). */
  launchModel?: (session: WatchedWorkspace, tool: AgentTool) => Promise<string | undefined>
  /** The workspace's effort level, injected like `recordedSessions` (see
   *  `AgentConnectDeps.effort`). */
  effort?: (session: WatchedWorkspace) => Promise<string | undefined>
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

export class WorkspaceStatusWatcher {
  private connection: { close(): void } | null = null
  /** The driver's read-only tmux channel while its stream is up. */
  private send: ((cmd: string) => Promise<string>) | null = null
  /** Bumped per terminal listing, so only the newest one is stored. */
  private listing = 0
  private stopped = false
  /** Bumped on each teardown so late observations from a dead connection
   *  are ignored. */
  private generation = 0
  private backoffMs: number
  private respawnTimer: NodeJS.Timeout | null = null
  private consecutiveFailures = 0

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
    this.backoffMs = this.respawnDelayMs
  }

  start(): void {
    this.stopped = false
    this.connect()
  }

  /**
   * Retire the watcher for good. A connection drop parks a chat's queued
   * messages for the reconnect; stopping is when no reconnect will come, so
   * they are discarded rather than sent if the workspace is resumed later.
   */
  stop(): void {
    this.stopped = true
    if (this.respawnTimer) clearTimeout(this.respawnTimer)
    this.respawnTimer = null
    this.teardown()
    dropAcpQueues(this.session.projectId, this.session.workspaceId)
  }

  private connect(): void {
    if (this.stopped) return
    const generation = ++this.generation
    const driver = agentDriver(this.session.mode)
    this.connection = driver.connect(
      this.session,
      (obs) => this.onObservation(generation, obs),
      {
        heartbeatIntervalMs: this.heartbeatIntervalMs,
        commandTimeoutMs: this.commandTimeoutMs,
        log: this.log,
        ...(this.deps.dial !== undefined ? { dial: this.deps.dial } : {}),
        ...(this.deps.recordedSessions !== undefined
          ? { recordedSessions: () => this.deps.recordedSessions!(this.session) }
          : {}),
        ...(this.deps.permissionMode !== undefined
          ? { permissionMode: () => this.deps.permissionMode!(this.session) }
          : {}),
        ...(this.deps.launchModel !== undefined
          ? { launchModel: (tool: AgentTool) => this.deps.launchModel!(this.session, tool) }
          : {}),
        ...(this.deps.effort !== undefined
          ? { effort: () => this.deps.effort!(this.session) }
          : {}),
      },
    )
  }

  private onObservation(generation: number, obs: AgentObservation): void {
    if (generation !== this.generation || this.stopped) return
    const { projectId, workspaceId } = this.session
    switch (obs.kind) {
      case 'up':
        setWorkspaceStreamHealth(projectId, workspaceId, true)
        this.backoffMs = this.respawnDelayMs
        this.consecutiveFailures = 0
        return
      case 'status':
        setAgentStatus(projectId, workspaceId, obs.handle, obs.status)
        return
      case 'live-agents':
        setLiveAgents(projectId, workspaceId, obs.agents)
        return
      case 'command-channel':
        this.send = obs.send
        this.refreshTerminals()
        return
      case 'windows-changed':
        this.refreshTerminals()
        return
      case 'down':
        this.onConnectionDown(generation, obs.reason)
        return
    }
  }

  /** Best-effort: a failed listing keeps the last one, and the next window
   *  event or reconnect lists again. */
  private refreshTerminals(): void {
    const send = this.send
    if (!send) return
    const listing = ++this.listing
    const { projectId, workspaceId } = this.session
    void listTerminals(send).then((entries) => {
      if (listing === this.listing && send === this.send) setWorkspaceTerminals(projectId, workspaceId, entries)
    }, () => { /* see above */ })
  }

  /** Idempotent per generation; flips health, never status. */
  private onConnectionDown(generation: number, reason: string): void {
    if (generation !== this.generation) return
    this.generation++
    this.consecutiveFailures++
    this.log(`[server] status-watcher ${this.session.workspaceId}: ${reason}`)
    this.teardown()
    setWorkspaceStreamHealth(this.session.projectId, this.session.workspaceId, false)
    this.scheduleRespawn()
  }

  private teardown(): void {
    this.send = null
    this.connection?.close()
    this.connection = null
  }

  private scheduleRespawn(): void {
    if (this.stopped || this.respawnTimer) return
    // Self-heal: repeated deaths may mean the in-workspace stream daemon is
    // down, which no new connection can fix, so ask the driver to revive it
    // (`reviveStatusStream`). Only every 3rd consecutive failure, so a proxy
    // outage does not trigger a storm of revives. Best-effort; a really dead
    // workspace is the reaper's.
    if (this.consecutiveFailures > 0 && this.consecutiveFailures % 3 === 0) {
      this.log(`[server] status-watcher ${this.session.workspaceId}: re-execing streamd (self-heal)`)
      void this.reviveStreamd(this.session.jobName).catch((err: unknown) => {
        this.log(`[server] status-watcher ${this.session.workspaceId}: streamd revive failed: ${String(err)}`)
      })
    }
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null
      this.connect()
    }, this.backoffMs)
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxRespawnDelayMs)
  }
}

/**
 * Keeps one `WorkspaceStatusWatcher` per running workspace. `sync` is driven
 * by the driver's workspace set: a new workspace (or a newly claimed spare)
 * gets a watcher; a vanished one has its watcher stopped and its store entry
 * evicted.
 *
 * Of the prewarmed spares, only `acp` ones are watched: connecting runs the
 * ACP handshake, which boots the agent's conversation, so a claim finds it
 * ready. The watcher is kept across the claim. A `tui` agent boots without
 * a client, so its spares are left alone.
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
      if (!p.running || !p.workspaceId || !p.projectId || (p.prewarmed && p.mode !== 'acp')) continue
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
        tool: workspace.tool,
        mode: workspace.mode,
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
