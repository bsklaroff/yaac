/**
 * The `tui` driver: a coding agent rendering its own terminal UI inside tmux,
 * observed through one persistent tmux control-mode client per session pod.
 *
 * This is yaac's original (and still default) way of running an agent, moved
 * behind `AgentDriver` unchanged. The interesting part is that no tool's
 * status is read from raw pane output — every tool is classified through a
 * `refresh-client -B` subscription on a per-tool format, so tmux pushes the
 * resolved value at its first ~1s format check and again on every change.
 * That matters because an idle pane emits no output, ever: without the
 * subscription there would be no signal at all for the state that most needs
 * one. The format differs by where each tool publishes its state:
 *
 *  - claude / codex put busy/idle in the pane's OSC title, so the format is
 *    `#{pane_title}` and the pushed value is classified in the server
 *    (`classifyAgentObservation`).
 *  - opencode / pi render it into the pane, so `agentStatusFormat` builds a
 *    content search over the visible grid (`#{C/ri:}`) that resolves *inside
 *    tmux* and pushes an already-resolved `running`/`waiting`.
 *
 * Because of that, every connection attaches `no-output`: agent TUI redraws
 * never cross the stream, only the short status value does.
 *
 * Each pane gets a second subscription the same way, on what its tool reports
 * about itself (`agentReportFormat`): its model — a pane option the tool's own
 * reporter sets, or for codex a cut of its title — and its permission mode,
 * another pane option. A `/model` or a Shift+Tab therefore arrives as a push
 * too, and rides out on the live set.
 *
 * And every pane — a scratch shell as much as an agent window — gets a third,
 * on the conversation its tool says it holds (`PANE_SESSION_FORMAT`), so a
 * `/clear` or an agent started by hand in a shell is a push as well. The live
 * set carries each pane's conversation id, exactly as the acp driver's does.
 *
 * A conversation's handle here is its tmux pane id (`%3`).
 */

import { StringDecoder } from 'node:string_decoder'
import { type StreamChild, type WorkspacePaths } from '#drivers/contract'
import { serverLog } from '#log'
import { ControlModeClient, type ControlModeNotification } from './control-mode'
import {
  PANE_SESSION_FORMAT,
  agentReportFormat,
  agentStatusFormat,
  agentWindowTool,
  classifyAgentObservation,
  parsePaneSession,
  resolveAgentModel,
  splitAgentReport,
  type PaneSession,
} from './agent-tools'
import { buildAgentCmd, buildPromptPasteBgCmd } from './agent-command'
import { worktreeDriver } from '#drivers/driver'
import type {
  AgentConnectDeps,
  AgentConnection,
  AgentDriver,
  AgentLaunchSpec,
  AgentObservation,
  DrivenWorktree,
  LiveAgent,
} from './drivers'
import type { AgentTool } from '@yaac/shared/types'

/** Subscription names are per pane, never shared — see `subscriptionName`. */
const SUBSCRIPTION_PREFIX = 'status-'
/** The second subscription each agent pane gets: what its tool reports
 *  about itself (`agentReportFormat`). */
const REPORT_SUBSCRIPTION_PREFIX = 'report-'
/** The one subscription EVERY pane gets: the conversation it holds. */
const SESSION_SUBSCRIPTION_PREFIX = 'session-'
/** The one a placeholder pane gets, until an agent is respawned into it. */
const BOOT_SUBSCRIPTION_PREFIX = 'boot-'

/**
 * `1` while a pane still runs the `sleep infinity` keepalive a session opens
 * on, in the window its agent is later respawned into (tmux quotes the start
 * command in some versions). Published as an agent, it would name no
 * conversation, and so mark every one the launch recorded inactive.
 */
const PLACEHOLDER_FORMAT = '#{m/r:^"?sleep infinity"?$,#{pane_start_command}}'

/**
 * The tmux subscription name for one agent pane.
 *
 * It MUST be unique per pane: `refresh-client -B <name>:<pane>:<format>` keys
 * subscriptions by name, so subscribing a second pane under a name the client
 * already holds *replaces* the first rather than adding to it, and that pane
 * silently stops reporting. With one agent per worktree the bug is invisible;
 * with two, only the last-subscribed pane ever pushes a status — a waiting
 * primary agent reads as running and never raises attention.
 *
 * The pane id's `%` is dropped so the name stays alphanumeric.
 */
function subscriptionName(prefix: string, paneId: string): string {
  return `${prefix}${paneId.replace('%', '')}`
}

/**
 * tmux attach-client flags for a status connection. `read-only` (it must never
 * inject input), `ignore-size` (kept out of window-size negotiation, so it
 * can't reshape the grid the content search reads), and `no-output` (no tool's
 * status comes from raw pane output, so agent TUI redraws never cross the
 * stream — only the subscription's short status value does).
 */
export function attachClientFlags(): string {
  return 'read-only,ignore-size,no-output'
}

/** The in-workspace control-mode attach argv, dialed as a ctrl stream. */
function attachArgv(paths: WorkspacePaths): string[] {
  return [
    'tmux', '-S', paths.tmuxSock, '-C', 'attach-session', '-t', 'yaac', '-f', attachClientFlags(),
  ]
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

class TuiConnection implements AgentConnection {
  private child: StreamChild | null = null
  private client: ControlModeClient | null = null
  /** Panes we hold a status subscription on, each with the tool its window
   *  runs — a worktree's panes need not share one, and the pushed value is
   *  classified against that tool's grammar. */
  private readonly subscribed = new Map<string, AgentTool>()
  /** Each pane's model, as its model subscription last resolved it. */
  private readonly models = new Map<string, string>()
  /** Each pane's latest pushed model value, so a resolution that finishes
   *  after a newer push (codex's is a file read) is dropped, not published. */
  private readonly modelPushes = new Map<string, string>()
  /** Each pane's reported permission mode, as its tool last put it. */
  private readonly modes = new Map<string, string>()
  /** Every pane we hold a session subscription on, with the conversation it
   *  last named — agent windows and scratch shells alike. */
  private readonly sessions = new Map<string, PaneSession | undefined>()
  private heartbeatTimer: NodeJS.Timeout | null = null
  private heartbeatInFlight = false
  private done = false
  private readonly heartbeatIntervalMs: number
  private readonly commandTimeoutMs: number
  private readonly log: (msg: string) => void

  constructor(
    private readonly session: DrivenWorktree,
    private readonly sink: (obs: AgentObservation) => void,
    deps: AgentConnectDeps,
  ) {
    this.heartbeatIntervalMs = deps.heartbeatIntervalMs ?? 20_000
    this.commandTimeoutMs = deps.commandTimeoutMs ?? 10_000
    this.log = deps.log ?? serverLog

    let child: StreamChild
    try {
      const paths = worktreeDriver().workspacePaths(session.jobName)
      child = (deps.dial ?? ((s, argv) => worktreeDriver().dialCtrl(s.jobName, argv)))(
        session, attachArgv(paths),
      )
    } catch (err) {
      this.down(`spawn failed: ${String(err)}`)
      return
    }
    this.child = child

    const client = new ControlModeClient(
      (data) => child.stdin?.write(data),
      (n) => this.onNotification(n),
    )
    this.client = client
    // Same hazard as the ACP transport: TCP read boundaries can split a
    // multi-byte character, and control mode carries plenty of them — claude's
    // Braille spinner in a pane title, a content search's matched text. Decoded
    // per chunk, a split glyph would arrive as replacement characters and could
    // flip a status classification on the tool whose grammar reads that title.
    const decoder = new StringDecoder('utf8')
    child.stdout?.on('data', (chunk) => {
      if (!this.done) client.feed(typeof chunk === 'string' ? chunk : decoder.write(chunk))
    })
    child.stderr?.on('data', () => { /* no stderr on ctrl streams — exit logs */ })
    child.on('error', (err) => this.down(`child error: ${String(err)}`))
    child.on('exit', () => this.down('stream closed'))

    void this.init(client).catch((err: unknown) => this.down(`init failed: ${String(err)}`))
  }

  private send(cmd: string): Promise<string> {
    const client = this.client
    if (!client) return Promise.reject(new Error('control stream is gone'))
    return withTimeout(client.send(cmd), this.commandTimeoutMs, `tmux ${cmd.split(' ')[0]}`)
  }

  /**
   * Post-attach setup, all over the stream: enumerate the agent panes and
   * subscribe to each one's status format. tmux pushes the current value at
   * its next ~1s format check, so the first classification arrives without any
   * change; until then the attach itself already proves tmux is up.
   */
  private async init(client: ControlModeClient): Promise<void> {
    await this.syncPanes()
    if (this.done) return
    this.sink({ kind: 'up' })
    // The stream is proven end to end — publish it as the session's command
    // channel so read-only tmux queries (the webapp terminals listing) ride
    // this connection instead of spawning their own exec.
    this.sink({ kind: 'command-channel', send: (cmd) => withTimeout(client.send(cmd), this.commandTimeoutMs, `tmux ${cmd.split(' ')[0]}`) })
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), this.heartbeatIntervalMs)
  }

  /**
   * Enumerate the panes and subscribe each one's formats. An agent pane is one
   * whose window is an agent window — `<tool>` for the worktree's original
   * agent, `<tool>-2`, `<tool>-3`, … for the extra conversations a restart
   * brings back or a user opens — and only those get a status and a report
   * subscription: an init window or a scratch shell has no agent status, and
   * what a hand-run agent reports about its posture is not the worktree's.
   * Every pane gets the session one, which is how a conversation started by
   * hand in a shell is recorded too.
   *
   * The listing itself carries each pane's session value, and every listing
   * refreshes them. A subscription's first push lands up to a second after
   * it is made, and a live set published before it would name no
   * conversation at all — which the registry would record as every agent
   * having exited, on every attach and reconnect.
   *
   * Re-run on every heartbeat and on window add/close, so a conversation
   * opened (or closed) mid-session is picked up without a reconnect. Already
   * subscribed panes are skipped, since re-subscribing the same pane under the
   * same name would just duplicate pushes. A respawn announces nothing, so a
   * placeholder pane is watched until the agent replaces it, and re-run then.
   */
  private async syncPanes(): Promise<void> {
    // Tab-separated: a window name or a transcript path can hold a space,
    // and the session format strips every tab.
    const listed = await this.send(
      `list-panes -s -F '#{pane_id}\t#{window_name}\t${PLACEHOLDER_FORMAT}\t${PANE_SESSION_FORMAT}' -t yaac`)
    if (this.done) return

    const panes = listed.split('\n')
      .map((line) => line.split('\t'))
      .flatMap(([paneId, windowName, placeholder, session]) => {
        if (paneId === undefined || !paneId.startsWith('%')) return []
        // Classify each pane against ITS tool's grammar, not the worktree's: a
        // pi pane read with claude's title format is permanently misclassified.
        const tool = placeholder === '1' ? undefined : agentWindowTool(windowName ?? '')
        return [{ paneId, placeholder: placeholder === '1', tool, session: parsePaneSession(session ?? '') }]
      })

    for (const { paneId } of panes.filter((p) => p.placeholder)) {
      await this.send(`refresh-client -B '${subscriptionName(BOOT_SUBSCRIPTION_PREFIX, paneId)}:${paneId}:${PLACEHOLDER_FORMAT}'`)
      if (this.done) return
    }

    if (!panes.some((p) => p.tool !== undefined)) {
      // Nothing to classify yet (the agent window is still being created).
      // Deliberately not published as an empty live set: that would read as
      // "every agent exited" and deactivate the worktree's conversations.
      return
    }

    // Only panes not yet watched are read from the listing — a watched one's
    // pushes are never older than it — and all at once, before any await: a
    // push that lands while a subscription below is in flight must stand.
    const unwatched = new Set(panes.filter((p) => !this.sessions.has(p.paneId)).map((p) => p.paneId))
    for (const { paneId, session } of panes) if (unwatched.has(paneId)) this.sessions.set(paneId, session)
    for (const { paneId, tool } of panes) {
      if (unwatched.has(paneId)) {
        await this.send(`refresh-client -B '${subscriptionName(SESSION_SUBSCRIPTION_PREFIX, paneId)}:${paneId}:${PANE_SESSION_FORMAT}'`)
        if (this.done) return
      }
      if (tool === undefined || this.subscribed.has(paneId)) continue
      // Single-quote the -B argument: tmux processes C escapes (`\b`, `\t`, …)
      // inside double quotes, which would corrupt an ERE word boundary in the
      // status format; single quotes carry the format string literally. Safe
      // because the format literal never contains a `'` (a pane title's runtime
      // value is expanded later, per-client — it's not on this command line).
      await this.send(`refresh-client -B '${subscriptionName(SUBSCRIPTION_PREFIX, paneId)}:${paneId}:${agentStatusFormat(tool)}'`)
      if (this.done) return
      await this.send(`refresh-client -B '${subscriptionName(REPORT_SUBSCRIPTION_PREFIX, paneId)}:${paneId}:${agentReportFormat(tool)}'`)
      if (this.done) return
      this.subscribed.set(paneId, tool)
    }
    const liveIds = panes.map((p) => p.paneId)
    for (const paneId of [...this.sessions.keys()]) {
      if (liveIds.includes(paneId)) continue
      this.subscribed.delete(paneId)
      this.models.delete(paneId)
      this.modelPushes.delete(paneId)
      this.modes.delete(paneId)
      this.sessions.delete(paneId)
    }
    this.publishAgents()
  }

  /**
   * The live set: every agent pane, and every other pane that names a
   * conversation, each with what it last reported. Held back until an agent
   * pane has been seen, for the reason `syncPanes` never publishes an empty
   * set.
   */
  private publishAgents(): void {
    if (this.subscribed.size === 0) return
    const agents: LiveAgent[] = []
    for (const [handle, session] of this.sessions) {
      const tool = this.subscribed.get(handle) ?? session?.tool
      if (tool === undefined) continue
      // Only its own tool's conversation: a respawned pane keeps its options,
      // so a spare retooled at claim still names its warm-time agent's.
      const own = session?.tool === tool ? session : undefined
      const model = this.models.get(handle)
      const reportedMode = this.modes.get(handle)
      agents.push({
        handle,
        tool,
        ...(own !== undefined ? { agentSessionId: own.agentSessionId } : {}),
        ...(own?.transcriptPath !== undefined ? { transcriptPath: own.transcriptPath } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(reportedMode !== undefined ? { reportedMode } : {}),
      })
    }
    this.sink({ kind: 'live-agents', agents })
  }

  /** A pane named a new conversation, or stopped naming one. */
  private onSession(paneId: string, value: string): void {
    if (this.done || !this.sessions.has(paneId)) return
    this.sessions.set(paneId, parsePaneSession(value))
    this.publishAgents()
  }

  /**
   * A pane's reported permission mode moved. Carried as the tool said it, to
   * be read as a posture where the worktree's row is (`LiveAgent.reportedMode`)
   * — opencode's agent means one thing under one launch and another under the
   * next. Empty leaves the last one standing, as for the model.
   */
  private onMode(paneId: string, mode: string): void {
    if (mode === '' || this.done || !this.subscribed.has(paneId)) return
    if (this.modes.get(paneId) === mode) return
    this.modes.set(paneId, mode)
    this.publishAgents()
  }

  /**
   * A pane's model format moved. Published as a change to the live set, which
   * is what the agent-session registry joins against — so a `/model` reaches
   * the conversation's row on its own reconcile pass, pushed by tmux rather
   * than polled out of a transcript. An empty value (nothing reported yet)
   * leaves the last one standing.
   */
  private async onModel(paneId: string, tool: AgentTool, value: string): Promise<void> {
    this.modelPushes.set(paneId, value)
    const model = await resolveAgentModel(tool, this.session.slug, value)
    if (this.modelPushes.get(paneId) !== value) return
    if (this.done || model === undefined || !this.subscribed.has(paneId)) return
    if (this.models.get(paneId) === model) return
    this.models.set(paneId, model)
    this.publishAgents()
  }

  private onNotification(n: ControlModeNotification): void {
    if (this.done) return
    if (n.kind === 'exit') {
      // The server is detaching us (tmux kill-server, detach-client) — the
      // child exits right after; let that path run teardown once.
      return
    }
    if (n.kind === 'windows-changed') {
      // A conversation was opened or closed; re-enumerate off the hot path.
      void this.resync()
      return
    }
    if (n.kind === 'subscription') {
      if (n.name.startsWith(BOOT_SUBSCRIPTION_PREFIX)) {
        // The agent was respawned into the placeholder: enumerate it as one.
        if (n.value === '0') void this.resync()
        return
      }
      if (n.name.startsWith(SESSION_SUBSCRIPTION_PREFIX)) {
        this.onSession(n.paneId, n.value)
        return
      }
      const tool = this.subscribed.get(n.paneId)
      if (tool === undefined) return
      if (n.name.startsWith(REPORT_SUBSCRIPTION_PREFIX)) {
        const { model, mode } = splitAgentReport(n.value)
        this.onMode(n.paneId, mode)
        void this.onModel(n.paneId, tool, model)
        return
      }
      if (!n.name.startsWith(SUBSCRIPTION_PREFIX)) return
      this.sink({
        kind: 'status',
        handle: n.paneId,
        status: classifyAgentObservation(tool, n.value),
      })
    }
    // %output — never subscribed to (every connection attaches no-output).
  }

  /** Re-enumerate on the open stream, swallowing failures: a wedged stream is
   *  the heartbeat's business, not this path's. */
  private async resync(): Promise<void> {
    if (this.done || !this.client) return
    try {
      await this.syncPanes()
    } catch {
      // the heartbeat owns wedge detection
    }
  }

  /**
   * Wedge detector: a cheap command whose reply proves the whole path
   * (relay → pod → tmux server) end to end. Rides the open stream — no extra
   * exec — and tears the stream down on a missed deadline.
   */
  private async heartbeat(): Promise<void> {
    if (this.done || this.heartbeatInFlight) return
    this.heartbeatInFlight = true
    try {
      await this.send('display-message -p ok')
      // Doubles as the pane-set refresh: window notifications cover the common
      // case, but a pane that came and went between them (or one added while
      // the stream was down) is caught here.
      await this.resync()
    } catch (err) {
      this.down(`heartbeat failed: ${String(err)}`)
    } finally {
      this.heartbeatInFlight = false
    }
  }

  private down(reason: string): void {
    if (this.done) return
    this.teardown()
    this.sink({ kind: 'down', reason })
  }

  private teardown(): void {
    this.done = true
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    this.sink({ kind: 'command-channel', send: null })
    this.client?.fail(new Error('stream torn down'))
    this.client = null
    this.child?.kill('SIGTERM')
    this.child = null
    this.subscribed.clear()
    this.models.clear()
    this.modelPushes.clear()
    this.modes.clear()
    this.sessions.clear()
  }

  close(): void {
    if (this.done) return
    this.log(`[server] tui-driver ${this.session.worktreeId}: closing`)
    this.teardown()
  }
}

export const tuiDriver: AgentDriver = {
  mode: 'tui',

  launchCmd(spec: AgentLaunchSpec): string {
    return buildAgentCmd({
      tool: spec.tool,
      worktreeId: spec.agentSessionId,
      resume: spec.resume,
      permissionMode: spec.permissionMode,
      paths: spec.paths,
      ...(spec.piProvider !== undefined ? { piProvider: spec.piProvider } : {}),
      ...(spec.model !== undefined ? { model: spec.model } : {}),
    })
  },

  connect(session, sink, deps = {}): AgentConnection {
    return new TuiConnection(session, sink, deps)
  },

  async deliverPrompt(session: DrivenWorktree, handle: string, text: string): Promise<void> {
    // The handle is a pane id, which is exactly what tmux's paste target
    // wants — no window-name indirection needed.
    const driver = worktreeDriver()
    const cmd = buildPromptPasteBgCmd(handle, text, driver.workspacePaths(session.jobName))
    await driver.exec(session.jobName, cmd, { maxAttempts: 1, timeout: 15_000 })
  },
}
