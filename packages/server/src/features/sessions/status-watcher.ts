import { type SessionPod, bootStreamd, dialCtrlStream, isPrewarmed } from '#platform/k8s'
import { classifyClaudeTitle } from '#features/sessions/agents/claude-status'
import { classifyCodexTitle } from '#features/sessions/agents/codex'
import { OPENCODE_BUSY_MARKERS } from '#features/sessions/agents/opencode'
import { PI_BUSY_MARKERS } from '#features/sessions/agents/pi-status'
import { normalizeTool } from '#features/sessions/state'
import {
  evictSessionStatus,
  setLiveAgentPanes,
  setPaneStatus,
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
import { AGENT_TOOLS, type AgentTool } from '@yaac/shared/types'

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

/** Subscription names are per pane, never shared — see `subscriptionName`. */
const SUBSCRIPTION_PREFIX = 'status-'

/**
 * The tmux subscription name for one agent pane.
 *
 * It MUST be unique per pane: `refresh-client -B <name>:<pane>:<format>`
 * keys subscriptions by name, so subscribing a second pane under a name the
 * client already holds *replaces* the first rather than adding to it, and
 * that pane silently stops reporting. With one agent per worktree the bug is
 * invisible; with two, only the last-subscribed pane ever pushes a status —
 * a waiting primary agent reads as running and never raises attention.
 *
 * The pane id's `%` is dropped so the name stays alphanumeric.
 */
function subscriptionName(paneId: string): string {
  return `${SUBSCRIPTION_PREFIX}${paneId.replace('%', '')}`
}

/**
 * The agent tool a tmux window runs, or undefined when it is not an agent
 * window. The worktree's original agent keeps the bare tool name (so every
 * existing `yaac:<tool>` pane target still resolves); the extra conversations
 * a restart brings back, or a user opens, are `<tool>-2`, `<tool>-3`, …
 *
 * Any tool matches, not just the worktree's: a worktree can hold a codex
 * conversation beside its claude ones, and matching only the worktree's tool
 * would drop that window from the live pane set — which in turn leaves its
 * link inactive, so the next restart silently forgets a conversation that was
 * running when the worktree stopped.
 *
 * Init-command windows and scratch shells are excluded — they have no agent
 * status to classify. An agent a user starts by hand inside a *scratch*
 * window is therefore linked as a conversation (its hook still fires) but
 * carries no status dot; naming the window after the tool is what opts it in.
 */
export function agentWindowTool(windowName: string): AgentTool | undefined {
  return AGENT_TOOLS.find((t) => windowName === t || new RegExp(`^${t}-\\d+$`).test(windowName))
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
  /** Panes we hold a status subscription on, each with the tool its window
   *  runs — a worktree's panes need not share one, and the pushed value is
   *  classified against that tool's grammar. Reset with the stream, since a
   *  new tmux client carries none of the old one's subscriptions. */
  private subscribedPanes = new Map<string, AgentTool>()
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
   * Post-attach setup, all over the stream: enumerate the agent panes and
   * subscribe to the tool's status format on each. tmux pushes the current
   * value at its next ~1s format check, so the first classification
   * arrives without any change; until then the attach itself already
   * proves tmux is up.
   */
  private async init(generation: number, client: ControlModeClient): Promise<void> {
    const send = (cmd: string): Promise<string> =>
      withTimeout(client.send(cmd), this.commandTimeoutMs, `tmux ${cmd.split(' ')[0]}`)

    await this.syncAgentPanes(generation, send)
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

  /**
   * Enumerate the panes running an agent and subscribe a status format on
   * each. An agent pane is one whose window is an agent window — `<tool>` for
   * the worktree's original agent, `<tool>-2`, `<tool>-3`, … for the extra
   * conversations a restart brings back or a user opens. Init windows and
   * scratch shells are deliberately excluded: they have no agent status to
   * classify.
   *
   * Re-run on every heartbeat and on window add/close, so a conversation
   * opened (or closed) mid-session is picked up without a reconnect. Already
   * subscribed panes are skipped, since re-subscribing the same pane under
   * the same name would just duplicate pushes.
   */
  private async syncAgentPanes(
    generation: number,
    send: (cmd: string) => Promise<string>,
  ): Promise<void> {
    const listed = await send(
      "list-panes -s -F '#{pane_id} #{window_name}' -t yaac",
    )
    if (generation !== this.streamGeneration || this.stopped) return

    const panes = listed.split('\n')
      .map((line) => line.trim().split(' '))
      .flatMap(([paneId, windowName]) => {
        if (paneId === undefined || !paneId.startsWith('%') || windowName === undefined) return []
        const paneTool = agentWindowTool(windowName)
        // Classify each pane against ITS tool's grammar, not the worktree's:
        // a pi pane read with claude's title format is permanently
        // misclassified.
        return paneTool === undefined ? [] : [{ paneId, tool: paneTool }]
      })

    if (panes.length === 0) {
      // Nothing to classify yet (the agent window is still being created).
      // Deliberately not published as an empty live set: that would read as
      // "every agent exited" and deactivate the worktree's conversations.
      return
    }

    for (const { paneId, tool: paneTool } of panes) {
      if (this.subscribedPanes.has(paneId)) continue
      // Single-quote the -B argument: tmux processes C escapes (`\b`, `\t`, …)
      // inside double quotes, which would corrupt an ERE word boundary in the
      // status format; single quotes carry the format string literally. Safe
      // because the format literal never contains a `'` (a pane title's runtime
      // value is expanded later, per-client — it's not on this command line).
      await send(`refresh-client -B '${subscriptionName(paneId)}:${paneId}:${statusFormat(paneTool)}'`)
      if (generation !== this.streamGeneration || this.stopped) return
      this.subscribedPanes.set(paneId, paneTool)
    }
    const liveIds = panes.map((p) => p.paneId)
    for (const paneId of [...this.subscribedPanes.keys()]) {
      if (!liveIds.includes(paneId)) this.subscribedPanes.delete(paneId)
    }
    setLiveAgentPanes(this.session.slug, this.session.sessionId, liveIds)
  }

  private onNotification(generation: number, n: ControlModeNotification): void {
    if (generation !== this.streamGeneration || this.stopped) return
    if (n.kind === 'exit') {
      // The server is detaching us (tmux kill-server, detach-client) —
      // the child exits right after; let that path run teardown once.
      return
    }
    if (n.kind === 'windows-changed') {
      // A conversation was opened or closed; re-enumerate off the hot path.
      void this.resyncPanes(generation)
      return
    }
    if (n.kind === 'subscription') {
      const paneTool = this.subscribedPanes.get(n.paneId)
      if (!n.name.startsWith(SUBSCRIPTION_PREFIX) || paneTool === undefined) return
      setPaneStatus(
        this.session.slug,
        this.session.sessionId,
        n.paneId,
        classifyAgentObservation(paneTool, n.value),
      )
      return
    }
    // %output — never subscribed to now (every watcher attaches no-output),
    // so agent pane redraws don't reach us. Ignored if one ever does.
  }

  /** Re-enumerate panes on the open stream, swallowing failures: a wedged
   *  stream is the heartbeat's business, not this path's. */
  private async resyncPanes(generation: number): Promise<void> {
    const client = this.client
    if (!client || generation !== this.streamGeneration || this.stopped) return
    try {
      await this.syncAgentPanes(generation, (cmd) =>
        withTimeout(client.send(cmd), this.commandTimeoutMs, `tmux ${cmd.split(' ')[0]}`))
    } catch {
      // the heartbeat owns wedge detection
    }
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
      // Doubles as the pane-set refresh: window notifications cover the
      // common case, but a pane that came and went between them (or one added
      // while the stream was down) is caught here.
      await this.resyncPanes(generation)
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
    this.subscribedPanes.clear()
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
