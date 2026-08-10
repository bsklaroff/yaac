import { type PodInfo, bootStreamd, isPrewarmed } from '#platform/k8s'
import {
  agentDriver,
  normalizeTool,
  type AgentConnectDeps,
  type AgentObservation,
  type DrivenWorktree,
} from '#runtime/agents'
import {
  evictWorktreeStatus,
  setAgentStatus,
  setLiveAgents,
  setWorktreeStreamHealth,
} from './status-store'
import {
  registerWorktreeControlStream,
  unregisterWorktreeControlStream,
  type ControlStreamSend,
} from './control-stream-registry'
import { serverLog } from '#log'
import type { AgentMode } from '@yaac/shared/types'

/**
 * Per-worktree status watchers: one live driver connection per running worktree
 * pod, held open through the proxy relay into the pod's streamd. Together with
 * the pod watcher this replaces every timer-driven status probe.
 *
 * The watcher deliberately knows nothing about *how* a connection observes an
 * agent. It picks a driver from the pod's mode (`#runtime/agents`), feeds the
 * observations into the status store, and owns the one thing both modes need
 * identically: what to do when a connection dies. That split is why adding
 * ACP mode did not add a second respawn loop, a second backoff curve, or a
 * second streamd self-heal — the parts most likely to drift if duplicated.
 *
 * A connection that drops flips the store's health bit and nothing else:
 * status stays sticky, and nothing here ever feeds the stale reaper.
 */

export interface WatchedWorktree extends DrivenWorktree {
  /** Which driver observes this worktree, from the pod's `yaac.mode` label. */
  mode: AgentMode
}

export interface StatusWatcherDeps {
  /**
   * The conversations yaac has already recorded for a worktree. Injected from
   * `main` rather than read here: the ACP driver needs it to re-address a live
   * agent, but the lookup is a database read, and `#runtime/status` importing
   * `#features/worktrees` would invert the one-directional dependency the two
   * features are built on (teardown calls in here to evict; never the reverse).
   */
  recordedSessions?: (session: WatchedWorktree) => Promise<Array<{ handle: string; agentSessionId: string }>>
  /**
   * Injected for tests — the streamd self-heal (see scheduleRespawn).
   * Default: `bootStreamd`, the one steady-state kubectl exec kept.
   */
  reviveStreamd?: (jobName: string) => Promise<void>
  /** Heartbeat cadence over the open connection. Default 20s. */
  heartbeatIntervalMs?: number
  /** Init-command / heartbeat reply deadline. Default 10s. */
  commandTimeoutMs?: number
  /** First respawn delay after a connection death; doubles to the max. */
  respawnDelayMs?: number
  maxRespawnDelayMs?: number
  /** Injected for tests — replaces the driver's real relay dial. */
  dial?: AgentConnectDeps['dial']
  log?: (msg: string) => void
}

export class WorktreeStatusWatcher {
  private connection: { close(): void } | null = null
  private registeredSend: ControlStreamSend | null = null
  private stopped = false
  /** Bumped whenever a connection is torn down, so a late observation from a
   *  dead one can never write to the store. */
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

  constructor(readonly session: WatchedWorktree, private readonly deps: StatusWatcherDeps = {}) {
    this.reviveStreamd = deps.reviveStreamd ?? bootStreamd
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

  stop(): void {
    this.stopped = true
    if (this.respawnTimer) clearTimeout(this.respawnTimer)
    this.respawnTimer = null
    this.teardown()
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
      },
    )
  }

  private onObservation(generation: number, obs: AgentObservation): void {
    if (generation !== this.generation || this.stopped) return
    const { slug, worktreeId } = this.session
    switch (obs.kind) {
      case 'up':
        setWorktreeStreamHealth(slug, worktreeId, true)
        this.backoffMs = this.respawnDelayMs
        this.consecutiveFailures = 0
        return
      case 'status':
        setAgentStatus(slug, worktreeId, obs.handle, obs.status)
        return
      case 'live-agents':
        setLiveAgents(slug, worktreeId, obs.agents)
        return
      case 'command-channel':
        this.setCommandChannel(obs.send)
        return
      case 'down':
        this.onConnectionDown(generation, obs.reason)
        return
    }
  }

  /**
   * Publish (or retract) the driver's read-only command channel, so unrelated
   * read-only tmux queries — the webapp's terminal listing — ride the open
   * connection instead of dialing their own. Only the TUI driver offers one.
   */
  private setCommandChannel(send: ControlStreamSend | null): void {
    if (this.registeredSend) {
      unregisterWorktreeControlStream(this.session.jobName, this.registeredSend)
      this.registeredSend = null
    }
    if (send) {
      this.registeredSend = send
      registerWorktreeControlStream(this.session.jobName, send)
    }
  }

  /** Idempotent per generation; flips health, never status. */
  private onConnectionDown(generation: number, reason: string): void {
    if (generation !== this.generation) return
    this.generation++
    this.consecutiveFailures++
    this.log(`[server] status-watcher ${this.session.worktreeId}: ${reason}`)
    this.teardown()
    setWorktreeStreamHealth(this.session.slug, this.session.worktreeId, false)
    this.scheduleRespawn()
  }

  private teardown(): void {
    this.setCommandChannel(null)
    this.connection?.close()
    this.connection = null
  }

  private scheduleRespawn(): void {
    if (this.stopped || this.respawnTimer) return
    // streamd self-heal: repeated connection deaths mean the daemon itself may
    // be down (crashed, or a pod predating it) — no relay stream can fix that,
    // so re-exec it via the one kubectl exec kept for this purpose. Every 3rd
    // consecutive failure, so a proxy outage (streamd fine) doesn't hammer the
    // apiserver with boots. Best-effort: if the pod is really dead the reaper
    // owns it.
    if (this.consecutiveFailures > 0 && this.consecutiveFailures % 3 === 0) {
      this.log(`[server] status-watcher ${this.session.worktreeId}: re-execing streamd (self-heal)`)
      void this.reviveStreamd(this.session.jobName).catch((err: unknown) => {
        this.log(`[server] status-watcher ${this.session.worktreeId}: streamd revive failed: ${String(err)}`)
      })
    }
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null
      this.connect()
    }, this.backoffMs)
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxRespawnDelayMs)
  }
}

/** The pod's mode label, defaulted. Every pod that predates modes — and every
 *  TUI pod, which never stamps one — reads as `tui`. */
export function podAgentMode(pod: PodInfo): AgentMode {
  return pod.mode === 'acp' ? 'acp' : 'tui'
}

/**
 * Keeps one `WorktreeStatusWatcher` per running, non-prewarmed worktree pod.
 * `sync` is driven by informer pod deltas: a pod that appears (or a claimed
 * spare that loses its prewarm label) gets a watcher; a pod that disappears
 * has its watcher stopped and its store entry evicted, so a restart reusing
 * the worktree id never sees stale status.
 */
export class StatusWatcherManager {
  private readonly watchers = new Map<string, WorktreeStatusWatcher>()

  constructor(private readonly deps: StatusWatcherDeps = {}) {}

  get size(): number {
    return this.watchers.size
  }

  sync(pods: PodInfo[]): void {
    const wanted = new Map<string, PodInfo>()
    for (const p of pods) {
      if (!p.running || !p.worktreeId || !p.projectSlug || isPrewarmed(p)) continue
      wanted.set(p.worktreeId, p)
    }
    for (const [worktreeId, watcher] of this.watchers) {
      if (wanted.has(worktreeId)) continue
      watcher.stop()
      this.watchers.delete(worktreeId)
      evictWorktreeStatus(watcher.session.slug, worktreeId)
    }
    for (const [worktreeId, pod] of wanted) {
      if (this.watchers.has(worktreeId)) continue
      const watcher = new WorktreeStatusWatcher({
        slug: pod.projectSlug,
        worktreeId,
        jobName: pod.jobName,
        tool: normalizeTool(pod.tool),
        mode: podAgentMode(pod),
      }, this.deps)
      watcher.start()
      this.watchers.set(worktreeId, watcher)
    }
  }

  stopAll(): void {
    for (const watcher of this.watchers.values()) watcher.stop()
    this.watchers.clear()
  }
}
