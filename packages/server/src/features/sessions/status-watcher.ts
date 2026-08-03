import { type SessionPod, bootStreamd, dialCtrlStream, isPrewarmed } from '#platform/k8s'
import { classifyClaudeTitle } from '#features/sessions/agents/claude-status'
import { classifyCodexTitle } from '#features/sessions/agents/codex'
import { OPENCODE_BUSY_MARKERS } from '#features/sessions/agents/opencode'
import { PI_BUSY_MARKERS } from '#features/sessions/agents/pi-status'
import { normalizeTool } from '#features/sessions/state'
import {
  evictSessionStatus,
  setSessionStatus,
  setSessionStreamHealth,
  type SessionAgentStatus,
} from '#features/sessions/status-store'
import {
  registerSessionControlStream,
  unregisterSessionControlStream,
  type ControlStreamSend,
} from '#features/sessions/control-stream-registry'
import { ControlModeClient, type ControlModeNotification } from '#features/sessions/control-mode'
import { serverLog } from '#log'
import { CONTAINER_TMUX_SOCK } from '@yaac/shared/paths'
import type { AgentTool } from '@yaac/shared/types'

/**
 * Per-session status watchers: one persistent tmux control-mode client
 * per running session pod, held open as a relay `ctrl` stream into the
 * pod's streamd (no TTY — control mode must not run under a PTY).
 * Together with the pod watcher this replaces every timer-driven status
 * probe.
 *
 * Every tool is classified the same way: the watcher subscribes
 * (`refresh-client -B`) to a per-tool status format and tmux pushes the
 * resolved value at the first ~1s format check and again on every change,
 * so there is no unclassified window — critical because an idle pane emits
 * no output, ever. The format differs by where the tool exposes its state:
 *
 * - claude / codex publish busy/idle in the pane's OSC title, so the
 *   format is `#{pane_title}` and the pushed value is classified in the
 *   server (`classifyAgentObservation`).
 * - opencode / pi render it into the pane, so the format is a
 *   `busyStatusFormat` that searches the visible grid (`#{C/ri:}`)
 *   *inside tmux* and pushes the already-resolved `running`/`waiting`.
 *
 * Because no tool's status is read from raw pane output, every watcher
 * attaches with the `no-output` client flag (`attachClientFlags`): agent
 * TUI redraws never cross the exec stream — only the short status value
 * does.
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
  /** Injected for tests — replaces the real relay ctrl-stream dial. */
  spawnAttach?: (session: WatchedSession) => AttachChild
  /**
   * Injected for tests — the streamd self-heal (see scheduleRespawn).
   * Default: `bootStreamd`, the one steady-state kubectl exec kept.
   */
  reviveStreamd?: (jobName: string) => Promise<void>
  /** Heartbeat cadence over the open stream. Default 20s. */
  heartbeatIntervalMs?: number
  /** Init-command / heartbeat reply deadline. Default 10s. */
  commandTimeoutMs?: number
  /** First respawn delay after a stream death; doubles to the max. */
  respawnDelayMs?: number
  maxRespawnDelayMs?: number
  log?: (msg: string) => void
}

/**
 * The tmux status format a tool's watcher subscribes to. claude/codex expose
 * busy/idle in the pane's OSC title, so the format is `#{pane_title}` and the
 * pushed value is classified server-side (`classifyAgentObservation`).
 * opencode/pi render it into the pane, so the format resolves the verdict
 * inside tmux and pushes `running`/`waiting` directly.
 */
function statusFormat(tool: AgentTool): string {
  if (tool === 'opencode') return busyStatusFormat(OPENCODE_BUSY_MARKERS)
  if (tool === 'pi') return busyStatusFormat(PI_BUSY_MARKERS)
  return '#{pane_title}'
}

/**
 * Build a tmux format that resolves to `running`/`waiting` by searching the
 * visible pane for any of `markers` (each an ERE, matched case-insensitively
 * via `#{C/ri:}` — a content search over the visible grid). The markers are
 * OR'd; a match in the pane means `running`, none means `waiting`.
 *
 * Markers must obey tmux-ERE limits (see the agent modules' definitions): no
 * `(?:...)` (use `(...)`), no `{n,}` interval (whose `}` would close the
 * `#{...}`), and no literal `,` (the `#{||:}`/`#{?}` argument separator).
 */
export function busyStatusFormat(markers: readonly string[]): string {
  const anyBusy = markers
    .map((m) => `#{C/ri:${m}}`)
    .reduceRight((acc, probe) => (acc ? `#{||:${probe},${acc}}` : probe), '')
  return `#{?${anyBusy},running,waiting}`
}

/**
 * Classify a pushed subscription value for a tool. claude/codex push the pane
 * title (classified by the Braille-spinner prefix); opencode/pi push an
 * already-resolved verdict from their tmux-side `busyStatusFormat`.
 */
export function classifyAgentObservation(tool: AgentTool, observed: string): SessionAgentStatus {
  if (tool === 'codex') return classifyCodexTitle(observed)
  if (tool === 'opencode' || tool === 'pi') return observed.trim() === 'running' ? 'running' : 'waiting'
  return classifyClaudeTitle(observed)
}

/**
 * tmux attach-client flags for a status watcher. `read-only` (it must never
 * inject input), `ignore-size` (kept out of window-size negotiation, so it
 * can't reshape the grid the content search reads), and `no-output` (no tool's
 * status comes from raw pane output, so agent TUI redraws never cross the exec
 * stream — only the subscription's short status value does).
 */
export function attachClientFlags(): string {
  return 'read-only,ignore-size,no-output'
}

/** The in-pod control-mode attach argv, dialed as a relay ctrl stream. */
function spawnRelayAttach(session: WatchedSession): AttachChild {
  return dialCtrlStream(session.sessionId, [
    'tmux', '-S', CONTAINER_TMUX_SOCK, '-C', 'attach-session', '-t', 'yaac', '-f', attachClientFlags(),
  ])
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

  private consecutiveFailures = 0

  private readonly spawnAttach: (session: WatchedSession) => AttachChild
  private readonly reviveStreamd: (jobName: string) => Promise<void>
  private readonly heartbeatIntervalMs: number
  private readonly commandTimeoutMs: number
  private readonly respawnDelayMs: number
  private readonly maxRespawnDelayMs: number
  private readonly log: (msg: string) => void

  constructor(readonly session: WatchedSession, deps: StatusWatcherDeps = {}) {
    this.spawnAttach = deps.spawnAttach ?? spawnRelayAttach
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
    this.teardownStream()
  }

  private connect(): void {
    if (this.stopped) return
    const generation = ++this.streamGeneration
    const { sessionId } = this.session

    let child: AttachChild
    try {
      child = this.spawnAttach(this.session)
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
    child.stderr?.on('data', () => { /* no stderr on ctrl streams — the exit path logs */ })
    child.on('error', (err) => this.onStreamDown(generation, `child error: ${String(err)}`))
    child.on('exit', () => this.onStreamDown(generation, 'stream closed'))

    void this.init(generation, client).catch((err: unknown) => {
      this.onStreamDown(generation, `init failed: ${String(err)}`)
    })
  }

  /**
   * Post-attach setup, all over the stream: resolve the agent pane id,
   * then subscribe to the tool's status format. tmux pushes the current
   * value at its next ~1s format check, so the first classification
   * arrives without any change; until then the attach itself already
   * proves tmux is up.
   */
  private async init(generation: number, client: ControlModeClient): Promise<void> {
    const { tool } = this.session
    const send = (cmd: string): Promise<string> =>
      withTimeout(client.send(cmd), this.commandTimeoutMs, `tmux ${cmd.split(' ')[0]}`)

    const paneId = (await send(`display-message -p -t yaac:${tool}.0 '#{pane_id}'`)).trim()
    if (!paneId.startsWith('%')) throw new Error(`unexpected pane id ${JSON.stringify(paneId)}`)
    if (generation !== this.streamGeneration || this.stopped) return
    this.agentPaneId = paneId

    // Single-quote the -B argument: tmux processes C escapes (`\b`, `\t`, …)
    // inside double quotes, which would corrupt an ERE word boundary in the
    // status format; single quotes carry the format string literally. Safe
    // because the format literal never contains a `'` (a pane title's runtime
    // value is expanded later, per-client — it's not on this command line).
    await send(`refresh-client -B 'status:${paneId}:${statusFormat(tool)}'`)
    if (generation !== this.streamGeneration || this.stopped) return
    setSessionStreamHealth(this.session.slug, this.session.sessionId, true)

    // The stream is proven end to end — publish it as the session's
    // command channel so read-only tmux queries (the webapp terminals
    // listing) ride this connection instead of spawning their own exec.
    const channel: ControlStreamSend = (cmd) =>
      withTimeout(client.send(cmd), this.commandTimeoutMs, `tmux ${cmd.split(' ')[0]}`)
    this.registeredSend = channel
    registerSessionControlStream(this.session.jobName, channel)

    this.backoffMs = this.respawnDelayMs
    this.consecutiveFailures = 0
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
    // %output — never subscribed to now (every watcher attaches no-output),
    // so agent pane redraws don't reach us. Ignored if one ever does.
  }

  private recordStatus(status: SessionAgentStatus): void {
    setSessionStatus(this.session.slug, this.session.sessionId, status)
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
    this.consecutiveFailures++
    this.log(`[server] status-watcher ${this.session.sessionId}: ${reason}`)
    this.teardownStream()
    setSessionStreamHealth(this.session.slug, this.session.sessionId, false)
    this.scheduleRespawn()
  }

  private teardownStream(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
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
    // streamd self-heal: repeated stream deaths mean the daemon itself may
    // be down (crashed, or a pod predating it) — no relay stream can fix
    // that, so re-exec it via the one kubectl exec kept for this purpose.
    // Every 3rd consecutive failure, so a proxy outage (streamd fine)
    // doesn't hammer the apiserver with boots. Best-effort: if the pod is
    // really dead the reaper owns it.
    if (this.consecutiveFailures > 0 && this.consecutiveFailures % 3 === 0) {
      this.log(`[server] status-watcher ${this.session.sessionId}: re-execing streamd (self-heal)`)
      void this.reviveStreamd(this.session.jobName).catch((err: unknown) => {
        this.log(`[server] status-watcher ${this.session.sessionId}: streamd revive failed: ${String(err)}`)
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
 * Keeps one `SessionStatusWatcher` per running, non-prewarmed session
 * pod. `sync` is driven by informer pod deltas: a pod that appears (or a
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
