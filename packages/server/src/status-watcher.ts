import { spawn } from 'node:child_process'
import { stdinExecArgs } from '#lib/k8s/exec'
import { isPrewarmed, type SessionPod } from '#lib/k8s/pods'
import { classifyClaudeTitle } from '#lib/session/claude-status'
import { classifyCodexTitle } from '#lib/session/codex-status'
import { classifyOpencodePane } from '#lib/session/opencode-status'
import { classifyPiPane } from '#lib/session/pi-status'
import { normalizeTool } from '#lib/session/status'
import {
  evictSessionStatus,
  setSessionStatus,
  setSessionStreamHealth,
  type SessionAgentStatus,
} from '#lib/session/status-store'
import {
  registerSessionControlStream,
  unregisterSessionControlStream,
  type ControlStreamSend,
} from '#lib/session/control-stream-registry'
import { ControlModeClient, type ControlModeNotification } from '#control-mode'
import { serverLog } from '#log'
import { CONTAINER_TMUX_SOCK } from '@yaac/shared/paths'
import type { AgentTool } from '@yaac/shared/types'

/**
 * Per-session status watchers: one persistent tmux control-mode client
 * per running session pod, held open through `kubectl exec -i` (no TTY
 * — control mode must not run under a PTY). Together with the pod
 * watcher this replaces every timer-driven status probe:
 *
 * - claude / codex: the watcher subscribes to the agent pane's
 *   `#{pane_title}` (`refresh-client -B`); tmux pushes the current
 *   value at the first ~1s format check and again on every change, so
 *   there is no unclassified window — critical because an idle pane
 *   emits no output, ever.
 * - opencode: status lives in the rendered pane, so `%output` events
 *   for the agent pane are a dirty bit that triggers a debounced
 *   `capture-pane` over the same stream. claude/codex attach with the
 *   `no-output` client flag instead, so their TUI redraw traffic never
 *   crosses the exec stream.
 *
 * A heartbeat command every `heartbeatIntervalMs` doubles as the wedge
 * detector (a hung exec stream would otherwise freeze status forever):
 * no reply within `commandTimeoutMs` tears the stream down and
 * respawns with backoff. Stream death only flips the store's health
 * bit — status stays sticky, and nothing here ever feeds the reaper.
 */

/** Minimal child-process surface, injectable for tests. */
export interface AttachChild {
  stdin: { write(data: string): void } | null
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null
  stderr: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null
  on(event: 'exit' | 'error', cb: (...args: unknown[]) => void): void
  kill(signal?: NodeJS.Signals): boolean
}

export interface WatchedSession {
  slug: string
  sessionId: string
  jobName: string
  tool: AgentTool
}

export interface StatusWatcherDeps {
  /** Injected for tests — replaces the real kubectl-exec spawn. */
  spawnAttach?: (jobName: string, tool: AgentTool) => AttachChild
  /** Heartbeat cadence over the open stream. Default 20s. */
  heartbeatIntervalMs?: number
  /** Init-command / heartbeat reply deadline. Default 10s. */
  commandTimeoutMs?: number
  /** Quiet window after an %output burst before re-capturing. Default 300ms. */
  captureDebounceMs?: number
  /** First respawn delay after a stream death; doubles to the max. */
  respawnDelayMs?: number
  maxRespawnDelayMs?: number
  log?: (msg: string) => void
}

/**
 * Whether a tool's status is read from the rendered pane (capture-pane +
 * %output dirty bit) rather than the pane's OSC title. opencode and pi both
 * render their busy/idle state into the pane and expose no reliable title
 * signal; claude/codex push it through the title.
 */
function usesPaneCapture(tool: AgentTool): boolean {
  return tool === 'opencode' || tool === 'pi'
}

/**
 * Classify a watcher observation for a tool: the pane's OSC title for
 * claude/codex, captured pane content for opencode/pi.
 */
export function classifyAgentObservation(tool: AgentTool, observed: string): SessionAgentStatus {
  if (tool === 'codex') return classifyCodexTitle(observed)
  if (tool === 'opencode') return classifyOpencodePane(observed)
  if (tool === 'pi') return classifyPiPane(observed)
  return classifyClaudeTitle(observed)
}

function spawnKubectlAttach(jobName: string, tool: AgentTool): AttachChild {
  // read-only: the watcher must never inject input; ignore-size: keep
  // this client out of window-size negotiation (the pane-capture classifiers
  // read the rendered grid); no-output for title-based tools so agent
  // TUI redraws don't stream through the exec connection for nothing.
  const flags = usesPaneCapture(tool) ? 'read-only,ignore-size' : 'read-only,ignore-size,no-output'
  return spawn('kubectl', stdinExecArgs(jobName, [
    'tmux', '-S', CONTAINER_TMUX_SOCK, '-C', 'attach-session', '-t', 'yaac', '-f', flags,
  ]), { stdio: ['pipe', 'pipe', 'pipe'] })
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (err: unknown) => { clearTimeout(timer); reject(err instanceof Error ? err : new Error(String(err))) },
    )
  })
}

export class SessionStatusWatcher {
  private child: AttachChild | null = null
  private client: ControlModeClient | null = null
  private registeredSend: ControlStreamSend | null = null
  private agentPaneId: string | null = null
  private stopped = false
  private streamGeneration = 0
  private backoffMs: number
  private respawnTimer: NodeJS.Timeout | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private heartbeatInFlight = false
  private captureTimer: NodeJS.Timeout | null = null
  private captureInFlight = false
  private captureDirty = false

  private readonly spawnAttach: (jobName: string, tool: AgentTool) => AttachChild
  private readonly heartbeatIntervalMs: number
  private readonly commandTimeoutMs: number
  private readonly captureDebounceMs: number
  private readonly respawnDelayMs: number
  private readonly maxRespawnDelayMs: number
  private readonly log: (msg: string) => void

  constructor(readonly session: WatchedSession, deps: StatusWatcherDeps = {}) {
    this.spawnAttach = deps.spawnAttach ?? spawnKubectlAttach
    this.heartbeatIntervalMs = deps.heartbeatIntervalMs ?? 20_000
    this.commandTimeoutMs = deps.commandTimeoutMs ?? 10_000
    this.captureDebounceMs = deps.captureDebounceMs ?? 300
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
    this.teardownStream()
  }

  private connect(): void {
    if (this.stopped) return
    const generation = ++this.streamGeneration
    const { sessionId, jobName, tool } = this.session

    let child: AttachChild
    try {
      child = this.spawnAttach(jobName, tool)
    } catch (err) {
      this.log(`[server] status-watcher ${sessionId}: spawn failed: ${String(err)}`)
      this.scheduleRespawn()
      return
    }
    this.child = child

    const client = new ControlModeClient(
      (data) => child.stdin?.write(data),
      (n) => this.onNotification(generation, n),
    )
    this.client = client
    child.stdout?.on('data', (chunk) => {
      if (generation === this.streamGeneration) client.feed(chunk.toString())
    })
    child.stderr?.on('data', () => { /* kubectl chatter — the exit path logs */ })
    child.on('error', (err) => this.onStreamDown(generation, `child error: ${String(err)}`))
    child.on('exit', () => this.onStreamDown(generation, 'stream closed'))

    void this.init(generation, client).catch((err: unknown) => {
      this.onStreamDown(generation, `init failed: ${String(err)}`)
    })
  }

  /**
   * Post-attach setup, all over the stream: resolve the agent pane id,
   * then either subscribe to its title (claude/codex) or take the
   * initial pane capture (opencode — its subscription is the %output
   * dirty bit, which needs no registration).
   */
  private async init(generation: number, client: ControlModeClient): Promise<void> {
    const { tool } = this.session
    const send = (cmd: string): Promise<string> =>
      withTimeout(client.send(cmd), this.commandTimeoutMs, `tmux ${cmd.split(' ')[0]}`)

    const paneId = (await send(`display-message -p -t yaac:${tool}.0 '#{pane_id}'`)).trim()
    if (!paneId.startsWith('%')) throw new Error(`unexpected pane id ${JSON.stringify(paneId)}`)
    if (generation !== this.streamGeneration || this.stopped) return
    this.agentPaneId = paneId

    if (usesPaneCapture(tool)) {
      const pane = await send(`capture-pane -pJ -t yaac:${tool}.0`)
      if (generation !== this.streamGeneration || this.stopped) return
      this.recordStatus(classifyAgentObservation(tool, pane))
    } else {
      await send(`refresh-client -B "status:${paneId}:#{pane_title}"`)
      if (generation !== this.streamGeneration || this.stopped) return
      // The subscription pushes the current title at tmux's next ~1s
      // format check, so the first classification arrives without any
      // title change. Until then the attach itself already proves tmux
      // is up.
      setSessionStreamHealth(this.session.slug, this.session.sessionId, true)
    }

    // The stream is proven end to end — publish it as the session's
    // command channel so read-only tmux queries (the webapp terminals
    // listing) ride this connection instead of spawning their own exec.
    const channel: ControlStreamSend = (cmd) =>
      withTimeout(client.send(cmd), this.commandTimeoutMs, `tmux ${cmd.split(' ')[0]}`)
    this.registeredSend = channel
    registerSessionControlStream(this.session.jobName, channel)

    this.backoffMs = this.respawnDelayMs
    this.heartbeatTimer = setInterval(() => void this.heartbeat(generation), this.heartbeatIntervalMs)
  }

  private onNotification(generation: number, n: ControlModeNotification): void {
    if (generation !== this.streamGeneration || this.stopped) return
    if (n.kind === 'exit') {
      // The server is detaching us (tmux kill-server, detach-client) —
      // the child exits right after; let that path run teardown once.
      return
    }
    if (n.kind === 'subscription') {
      if (n.name !== 'status' || n.paneId !== this.agentPaneId) return
      this.recordStatus(classifyAgentObservation(this.session.tool, n.value))
      return
    }
    // %output — only meaningful as the pane-capture tools' dirty bit.
    if (!usesPaneCapture(this.session.tool) || n.paneId !== this.agentPaneId) return
    this.scheduleCapture(generation)
  }

  private recordStatus(status: SessionAgentStatus): void {
    setSessionStatus(this.session.slug, this.session.sessionId, status)
  }

  /** Debounced-trailing capture: bursts of %output collapse to one. */
  private scheduleCapture(generation: number): void {
    if (this.captureInFlight) {
      this.captureDirty = true
      return
    }
    if (this.captureTimer) return
    this.captureTimer = setTimeout(() => {
      this.captureTimer = null
      void this.capture(generation)
    }, this.captureDebounceMs)
  }

  private async capture(generation: number): Promise<void> {
    const client = this.client
    if (!client || generation !== this.streamGeneration || this.stopped) return
    this.captureInFlight = true
    this.captureDirty = false
    try {
      const pane = await withTimeout(
        client.send(`capture-pane -pJ -t yaac:${this.session.tool}.0`),
        this.commandTimeoutMs,
        'tmux capture-pane',
      )
      if (generation !== this.streamGeneration || this.stopped) return
      this.recordStatus(classifyAgentObservation(this.session.tool, pane))
    } catch (err) {
      this.onStreamDown(generation, `capture failed: ${String(err)}`)
      return
    } finally {
      this.captureInFlight = false
    }
    if (this.captureDirty) this.scheduleCapture(generation)
  }

  /**
   * Wedge detector: a cheap command whose reply proves the whole path
   * (apiserver → pod → tmux server) end to end. Rides the open stream —
   * no extra exec — and tears the stream down on a missed deadline.
   */
  private async heartbeat(generation: number): Promise<void> {
    const client = this.client
    if (!client || this.heartbeatInFlight || generation !== this.streamGeneration || this.stopped) return
    this.heartbeatInFlight = true
    try {
      await withTimeout(client.send('display-message -p ok'), this.commandTimeoutMs, 'heartbeat')
    } catch (err) {
      this.onStreamDown(generation, `heartbeat failed: ${String(err)}`)
    } finally {
      this.heartbeatInFlight = false
    }
  }

  /** Idempotent per stream generation; flips health, never status. */
  private onStreamDown(generation: number, reason: string): void {
    if (generation !== this.streamGeneration) return
    this.streamGeneration++
    this.log(`[server] status-watcher ${this.session.sessionId}: ${reason}`)
    this.teardownStream()
    setSessionStreamHealth(this.session.slug, this.session.sessionId, false)
    this.scheduleRespawn()
  }

  private teardownStream(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    if (this.captureTimer) clearTimeout(this.captureTimer)
    this.captureTimer = null
    this.captureDirty = false
    if (this.registeredSend) {
      unregisterSessionControlStream(this.session.jobName, this.registeredSend)
      this.registeredSend = null
    }
    this.client?.fail(new Error('stream torn down'))
    this.client = null
    this.child?.kill('SIGTERM')
    this.child = null
    this.agentPaneId = null
  }

  private scheduleRespawn(): void {
    if (this.stopped || this.respawnTimer) return
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null
      this.connect()
    }, this.backoffMs)
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxRespawnDelayMs)
  }
}

/**
 * Keeps one `SessionStatusWatcher` per running, non-prewarmed session
 * pod. `sync` is driven by pod-watch changes: a pod that appears (or a
 * claimed spare that loses its prewarm label) gets a watcher; a pod
 * that disappears has its watcher stopped and its store entry evicted,
 * so a restart reusing the session id never sees stale status.
 */
export class StatusWatcherManager {
  private readonly watchers = new Map<string, SessionStatusWatcher>()

  constructor(private readonly deps: StatusWatcherDeps = {}) {}

  get size(): number {
    return this.watchers.size
  }

  sync(pods: SessionPod[]): void {
    const wanted = new Map<string, SessionPod>()
    for (const p of pods) {
      if (!p.running || !p.sessionId || !p.projectSlug || isPrewarmed(p)) continue
      wanted.set(p.sessionId, p)
    }
    for (const [sessionId, watcher] of this.watchers) {
      if (wanted.has(sessionId)) continue
      watcher.stop()
      this.watchers.delete(sessionId)
      evictSessionStatus(watcher.session.slug, sessionId)
    }
    for (const [sessionId, pod] of wanted) {
      if (this.watchers.has(sessionId)) continue
      const watcher = new SessionStatusWatcher({
        slug: pod.projectSlug,
        sessionId,
        jobName: pod.jobName,
        tool: normalizeTool(pod.tool),
      }, this.deps)
      watcher.start()
      this.watchers.set(sessionId, watcher)
    }
  }

  stopAll(): void {
    for (const watcher of this.watchers.values()) watcher.stop()
    this.watchers.clear()
  }
}
