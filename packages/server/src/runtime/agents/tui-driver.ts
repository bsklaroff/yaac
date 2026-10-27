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

import { WorkspaceExecError } from '#drivers/contract'
import {
  BOOT_SUBSCRIPTION_PREFIX,
  ControlModeConnection,
  PLACEHOLDER_FORMAT,
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
import { assertLaunchableModel, buildAgentCmd, buildMessageCmd, buildPromptPasteBgCmd } from './agent-command'
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

/**
 * The subscription name for one pane. Must be unique per pane:
 * `refresh-client -B` keys subscriptions by name, so reusing a name
 * replaces the earlier pane's subscription and that pane silently stops
 * reporting. `%` is dropped to keep the name alphanumeric.
 */
function subscriptionName(prefix: string, paneId: string): string {
  return `${prefix}${paneId.replace('%', '')}`
}

class TuiConnection extends ControlModeConnection {
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
  /** Each pane's reported effort level, in its tool's words. */
  private readonly efforts = new Map<string, string>()
  /** Every pane with a session subscription (agent windows and scratch
   *  shells), with the conversation it last named. */
  private readonly sessions = new Map<string, PaneSession | undefined>()

  constructor(session: DrivenWorkspace, sink: (obs: AgentObservation) => void, deps: AgentConnectDeps) {
    super(session, sink, deps, 'tui-driver')
    this.start()
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
   * watched until the agent replaces it. tmux pushes each subscription's
   * value at its next ~1s check; until then the attach itself proves tmux
   * is up.
   */
  protected async sync(): Promise<void> {
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
      this.efforts.delete(paneId)
      this.sessions.delete(paneId)
    }
    this.publishAgents()
  }

  /**
   * The live set: every agent pane, plus any other pane naming a
   * conversation, with its latest reports. Not published until an agent pane
   * has been seen (see `sync`).
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
      const reportedEffort = this.efforts.get(handle)
      agents.push({
        handle,
        tool,
        ...(own !== undefined ? { agentSessionId: own.agentSessionId } : {}),
        ...(own?.transcriptPath !== undefined ? { transcriptPath: own.transcriptPath } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(reportedMode !== undefined ? { reportedMode } : {}),
        ...(reportedEffort !== undefined ? { reportedEffort } : {}),
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
   * A pane's reported permission mode or effort changed. Both are kept in
   * the tool's terms; the mode is mapped to a posture later
   * (`LiveAgent.reportedMode`), since opencode's agent means different
   * things under different launches. Empty keeps the previous value.
   */
  private onReport(paneId: string, mode: string, effort: string): void {
    if (this.done || !this.subscribed.has(paneId)) return
    let changed = false
    for (const [reports, value] of [[this.modes, mode], [this.efforts, effort]] as const) {
      if (value === '' || reports.get(paneId) === value) continue
      reports.set(paneId, value)
      changed = true
    }
    if (changed) this.publishAgents()
  }

  /**
   * A pane's model changed. Published as a live-set change, which the
   * agent-session registry joins against on its reconcile pass. Empty keeps
   * the previous value.
   */
  private async onModel(paneId: string, tool: AgentTool, value: string): Promise<void> {
    this.modelPushes.set(paneId, value)
    const model = await resolveAgentModel(tool, this.session.projectId, value)
    if (this.modelPushes.get(paneId) !== value) return
    if (this.done || model === undefined || !this.subscribed.has(paneId)) return
    if (this.models.get(paneId) === model) return
    this.models.set(paneId, model)
    this.publishAgents()
  }

  protected onSubscription(n: Extract<ControlModeNotification, { kind: 'subscription' }>): void {
    if (n.name.startsWith(SESSION_SUBSCRIPTION_PREFIX)) {
      this.onSession(n.paneId, n.value)
      return
    }
    const tool = this.subscribed.get(n.paneId)
    if (tool === undefined) return
    if (n.name.startsWith(REPORT_SUBSCRIPTION_PREFIX)) {
      const { model, mode, effort } = splitAgentReport(n.value)
      this.onReport(n.paneId, mode, effort)
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

  protected cleanup(): void {
    this.subscribed.clear()
    this.models.clear()
    this.modelPushes.clear()
    this.modes.clear()
    this.sessions.clear()
  }
}

/**
 * What each `buildMessageCmd` exit code tells the sender. Codes with several
 * causes (`MESSAGE_REFUSAL_DETAILED`) are followed by the one the script
 * named on its last stderr line.
 */
const MESSAGE_REFUSALS: Partial<Record<number, string>> = {
  1: 'the message never showed in the agent\'s input; nothing was submitted',
  3: 'nothing was typed',
  4: 'the agent is showing a prompt (a permission request, a question or another dialog) that '
    + 'opened after the message was typed, which sits unsubmitted in its input',
  5: 'its user\'s draft could not be set aside, so nothing was typed',
}
const MESSAGE_REFUSAL_DETAILED = new Set([3, 5])

export const tuiDriver: AgentDriver = {
  mode: 'tui',

  launchCmd(spec: AgentLaunchSpec): string {
    assertLaunchableModel(spec.tool, spec.model)
    return buildAgentCmd({
      tool: spec.tool,
      workspaceId: spec.agentSessionId,
      resume: spec.resume,
      permissionMode: spec.permissionMode,
      paths: spec.paths,
      ...(spec.piProvider !== undefined ? { piProvider: spec.piProvider } : {}),
      ...(spec.model !== undefined ? { model: spec.model } : {}),
      ...(spec.effort !== undefined ? { effort: spec.effort } : {}),
    })
  },

  connect(session, sink, deps = {}): AgentConnection {
    return new TuiConnection(session, sink, deps)
  },

  async deliverPrompt(session: DrivenWorkspace, handle: string, text: string, opts = {}): Promise<void> {
    // The handle is a pane id, a valid paste target.
    const driver = workspaceDriver()
    const paths = driver.workspacePaths(session.jobName)
    if (opts.running === undefined) {
      const { cmd, stdin } = buildPromptPasteBgCmd(handle, text, paths)
      await driver.exec(session.jobName, cmd, { maxAttempts: 1, timeout: 15_000, stdin })
      return
    }
    const { cmd, stdin } = buildMessageCmd(handle, text, paths, { tool: session.tool, agentSessionId: opts.running.agentSessionId })
    await driver.exec(session.jobName, cmd, {
      maxAttempts: 1,
      timeout: 30_000,
      stdin,
    }).catch((err: unknown) => {
      if (!(err instanceof WorkspaceExecError) || MESSAGE_REFUSALS[err.code] === undefined) throw err
      const refusal = MESSAGE_REFUSALS[err.code]
      const detail = err.stderr.trim().split('\n').at(-1) ?? ''
      throw new Error(MESSAGE_REFUSAL_DETAILED.has(err.code) && detail !== '' ? `${refusal}: ${detail}` : refusal)
    })
  },
}
