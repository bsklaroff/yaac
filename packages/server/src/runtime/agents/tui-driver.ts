/**
 * The `tui` driver: an agent rendering its own terminal UI in tmux, observed
 * through one persistent tmux control-mode client per workspace.
 *
 * Status is never read from raw pane output. Each pane gets a
 * `refresh-client -B` subscription on a per-tool format, which tmux pushes
 * at its first ~1s check and on every change (an idle pane emits no output,
 * so this is the only signal for idleness):
 *
 *  - claude / codex put busy/idle in the OSC title; the format is
 *    `#{pane_title}`, classified server-side (`classifyAgentObservation`).
 *  - opencode / pi draw it in the pane; `agentStatusFormat` searches the
 *    visible grid (`#{C/ri:}`) inside tmux and pushes `running`/`waiting`.
 *
 * So connections attach `no-output` and only short values cross the stream.
 *
 * Agent panes also get a report subscription (`agentReportFormat`: model
 * and permission mode), and every pane, scratch shells included, gets a
 * session subscription (`PANE_SESSION_FORMAT`), so `/model`, Shift+Tab,
 * `/clear` and agents started by hand all arrive as pushes.
 *
 * A conversation's handle here is its tmux pane id (`%3`).
 */

import { StringDecoder } from 'node:string_decoder'
import type { StreamChild } from '#drivers/contract'
import { serverLog } from '#log'
import {
  ControlModeClient,
  PLACEHOLDER_FORMAT,
  controlModeAttachArgv,
  withTimeout,
  type ControlModeNotification,
} from './control-mode'
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
import { workspaceDriver } from '#drivers/driver'
import type {
  AgentConnectDeps,
  AgentConnection,
  AgentDriver,
  AgentLaunchSpec,
  AgentObservation,
  DrivenWorkspace,
  LiveAgent,
} from './drivers'
import type { AgentTool } from '@yaac/shared/types'

/** Subscription names are per pane; see `subscriptionName`. */
const SUBSCRIPTION_PREFIX = 'status-'
/** Per agent pane: what its tool reports (`agentReportFormat`). */
const REPORT_SUBSCRIPTION_PREFIX = 'report-'
/** Per pane, for every pane: the conversation it holds. */
const SESSION_SUBSCRIPTION_PREFIX = 'session-'
/** For a placeholder pane, until an agent is respawned into it. */
const BOOT_SUBSCRIPTION_PREFIX = 'boot-'

/**
 * The subscription name for one pane. Must be unique per pane:
 * `refresh-client -B` keys subscriptions by name, so reusing a name
 * replaces the earlier pane's subscription and that pane silently stops
 * reporting. `%` is dropped to keep the name alphanumeric.
 */
function subscriptionName(prefix: string, paneId: string): string {
  return `${prefix}${paneId.replace('%', '')}`
}

class TuiConnection implements AgentConnection {
  private child: StreamChild | null = null
  private client: ControlModeClient | null = null
  /** Panes with a status subscription, each with its window's tool (panes
   *  in one workspace can run different tools). */
  private readonly subscribed = new Map<string, AgentTool>()
  /** Each pane's model, as its model subscription last resolved it. */
  private readonly models = new Map<string, string>()
  /** Each pane's latest pushed model value, so a slow resolution (codex's
   *  is a file read) finishing after a newer push is dropped. */
  private readonly modelPushes = new Map<string, string>()
  /** Each pane's reported permission mode, as its tool last put it. */
  private readonly modes = new Map<string, string>()
  /** Every pane with a session subscription (agent windows and scratch
   *  shells), with the conversation it last named. */
  private readonly sessions = new Map<string, PaneSession | undefined>()
  private heartbeatTimer: NodeJS.Timeout | null = null
  private heartbeatInFlight = false
  private done = false
  private readonly heartbeatIntervalMs: number
  private readonly commandTimeoutMs: number
  private readonly log: (msg: string) => void

  constructor(
    private readonly session: DrivenWorkspace,
    private readonly sink: (obs: AgentObservation) => void,
    deps: AgentConnectDeps,
  ) {
    this.heartbeatIntervalMs = deps.heartbeatIntervalMs ?? 20_000
    this.commandTimeoutMs = deps.commandTimeoutMs ?? 10_000
    this.log = deps.log ?? serverLog

    let child: StreamChild
    try {
      const paths = workspaceDriver().workspacePaths(session.jobName)
      child = (deps.dial ?? ((s, argv) => workspaceDriver().dialCtrl(s.jobName, argv)))(
        session, controlModeAttachArgv(paths),
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
    // As in the ACP transport: chunks can split multi-byte characters (e.g.
    // claude's Braille spinner), which would corrupt titles and flip a
    // status classification.
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
   * Post-attach setup over the stream: list agent panes and subscribe each.
   * tmux pushes the current value at its next ~1s check; until then the
   * attach itself proves tmux is up.
   */
  private async init(client: ControlModeClient): Promise<void> {
    await this.syncPanes()
    if (this.done) return
    this.sink({ kind: 'up' })
    // Publish the stream as the workspace's read-only command channel so
    // queries like the terminal listing reuse it.
    this.sink({ kind: 'command-channel', send: (cmd) => withTimeout(client.send(cmd), this.commandTimeoutMs, `tmux ${cmd.split(' ')[0]}`) })
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), this.heartbeatIntervalMs)
  }

  /**
   * List panes and subscribe their formats. Agent panes (windows named
   * `<tool>`, `<tool>-2`, …) get status and report subscriptions; init
   * windows and scratch shells do not. Every pane gets the session
   * subscription, which records conversations started by hand in a shell.
   *
   * The listing includes each pane's current session value, since a
   * subscription's first push may lag up to a second and a live set
   * published before it would look like every agent exited.
   *
   * Re-run on each heartbeat and window add/close. Already-subscribed panes
   * are skipped. A respawn announces nothing, so a placeholder pane is
   * watched until the agent replaces it.
   */
  private async syncPanes(): Promise<void> {
    // Tab-separated: names and paths can contain spaces, and the session
    // format strips tabs.
    const listed = await this.send(
      `list-panes -s -F '#{pane_id}\t#{window_name}\t${PLACEHOLDER_FORMAT}\t${PANE_SESSION_FORMAT}' -t yaac`)
    if (this.done) return

    const panes = listed.split('\n')
      .map((line) => line.split('\t'))
      .flatMap(([paneId, windowName, placeholder, session]) => {
        if (paneId === undefined || !paneId.startsWith('%')) return []
        // Classify with the pane's own tool, not the workspace's.
        const tool = placeholder === '1' ? undefined : agentWindowTool(windowName ?? '')
        return [{ paneId, placeholder: placeholder === '1', tool, session: parsePaneSession(session ?? '') }]
      })

    for (const { paneId } of panes.filter((p) => p.placeholder)) {
      await this.send(`refresh-client -B '${subscriptionName(BOOT_SUBSCRIPTION_PREFIX, paneId)}:${paneId}:${PLACEHOLDER_FORMAT}'`)
      if (this.done) return
    }

    if (!panes.some((p) => p.tool !== undefined)) {
      // No agent window yet. Never publish an empty set, which would read
      // as "every agent exited".
      return
    }

    // Read only unwatched panes from the listing (a watched pane's pushes
    // are newer), all before any await so a push arriving meanwhile wins.
    const unwatched = new Set(panes.filter((p) => !this.sessions.has(p.paneId)).map((p) => p.paneId))
    for (const { paneId, session } of panes) if (unwatched.has(paneId)) this.sessions.set(paneId, session)
    for (const { paneId, tool } of panes) {
      if (unwatched.has(paneId)) {
        await this.send(`refresh-client -B '${subscriptionName(SESSION_SUBSCRIPTION_PREFIX, paneId)}:${paneId}:${PANE_SESSION_FORMAT}'`)
        if (this.done) return
      }
      if (tool === undefined || this.subscribed.has(paneId)) continue
      // Single-quote the -B argument: tmux processes C escapes inside double
      // quotes, which would corrupt an ERE `\b`. The format never contains
      // `'`.
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
   * The live set: every agent pane, plus any other pane naming a
   * conversation, with its latest reports. Not published until an agent pane
   * has been seen (see `syncPanes`).
   */
  private publishAgents(): void {
    if (this.subscribed.size === 0) return
    const agents: LiveAgent[] = []
    for (const [handle, session] of this.sessions) {
      const tool = this.subscribed.get(handle) ?? session?.tool
      if (tool === undefined) continue
      // Only its own tool's conversation: a respawned pane keeps its
      // options, so a retooled spare still names its warm-time agent's.
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
   * A pane's reported permission mode changed. Kept in the tool's terms and
   * mapped to a posture later (`LiveAgent.reportedMode`), since opencode's
   * agent means different things under different launches. Empty keeps the
   * previous value.
   */
  private onMode(paneId: string, mode: string): void {
    if (mode === '' || this.done || !this.subscribed.has(paneId)) return
    if (this.modes.get(paneId) === mode) return
    this.modes.set(paneId, mode)
    this.publishAgents()
  }

  /**
   * A pane's model changed. Published as a live-set change, which the
   * agent-session registry joins against on its reconcile pass. Empty keeps
   * the previous value.
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
      // tmux is detaching us; the child exit that follows runs teardown.
      return
    }
    if (n.kind === 'windows-changed') {
      // A window opened or closed; re-list off the hot path.
      void this.resync()
      return
    }
    if (n.kind === 'subscription') {
      if (n.name.startsWith(BOOT_SUBSCRIPTION_PREFIX)) {
        // An agent replaced the placeholder; list it as one.
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
    // %output: never received, since connections attach no-output.
  }

  /** Re-list panes, ignoring failures; the heartbeat detects a wedged
   *  stream. */
  private async resync(): Promise<void> {
    if (this.done || !this.client) return
    try {
      await this.syncPanes()
    } catch {
      // The heartbeat handles wedges.
    }
  }

  /**
   * Wedge detector: a cheap command over the open stream whose reply proves
   * the path to the tmux server; a missed deadline tears the stream down.
   */
  private async heartbeat(): Promise<void> {
    if (this.done || this.heartbeatInFlight) return
    this.heartbeatInFlight = true
    try {
      await this.send('display-message -p ok')
      // Also refreshes the pane set, catching panes that came and went
      // between window notifications or while the stream was down.
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
    this.log(`[server] tui-driver ${this.session.workspaceId}: closing`)
    this.teardown()
  }
}

export const tuiDriver: AgentDriver = {
  mode: 'tui',

  launchCmd(spec: AgentLaunchSpec): string {
    return buildAgentCmd({
      tool: spec.tool,
      workspaceId: spec.agentSessionId,
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

  async deliverPrompt(session: DrivenWorkspace, handle: string, text: string): Promise<void> {
    // The handle is a pane id, a valid paste target.
    const driver = workspaceDriver()
    const cmd = buildPromptPasteBgCmd(handle, text, driver.workspacePaths(session.jobName))
    await driver.exec(session.jobName, cmd, { maxAttempts: 1, timeout: 15_000 })
  },
}
