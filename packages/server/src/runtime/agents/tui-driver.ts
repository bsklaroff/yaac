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
 * Which windows run agents comes from the workspace's open `tui` sessions
 * (`AgentConnectDeps.sessions`). A session's agent is addressed by its
 * window name; one started by hand in a terminal by its pane id (`%3`).
 */

import { WorkspaceExecError } from '#drivers/contract'
import { ControlModeConnection, type ControlModeNotification } from './control-mode'
import {
  PANE_SESSION_FORMAT,
  agentReportFormat,
  agentStatusFormat,
  classifyAgentObservation,
  parsePaneSession,
  resolveAgentModel,
  splitAgentReport,
  type PaneSession,
} from './agent-tools'
import { assertLaunchableModel, buildAgentCmd, buildMessageCmd, buildPromptPasteBgCmd, windowTarget } from './agent-command'
import { workspaceDriver } from '#drivers/driver'
import type {
  AgentConnectDeps,
  AgentConnection,
  AgentDriver,
  AgentLaunchSpec,
  AgentObservation,
  DrivenWorkspace,
  LiveAgent,
  WatchedSession,
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

/** One listed pane. */
interface ListedPane {
  paneId: string
  /** The tool of the session whose agent runs in it; undefined for any
   *  other pane (a terminal, or a session pane past its first). */
  tool?: AgentTool
  /** Its session's window, the agent's handle. */
  window?: string
  dead: boolean
  session: PaneSession | undefined
}

class TuiConnection extends ControlModeConnection {
  /** Agent panes with status and report subscriptions, each with its
   *  session's tool and window (panes in one workspace can run different
   *  tools). */
  private readonly subscribed = new Map<string, { tool: AgentTool; window: string }>()
  /** Each pane's model, as its model subscription last resolved it. */
  private readonly models = new Map<string, string>()
  /** Each pane's latest pushed model value, so a slow resolution (codex's
   *  is a file read) finishing after a newer push is dropped. */
  private readonly modelPushes = new Map<string, string>()
  /** Each pane's reported permission mode, as its tool last put it. */
  private readonly modes = new Map<string, string>()
  /** Each pane's reported effort level, in its tool's words. */
  private readonly efforts = new Map<string, string>()
  /** Every pane with a session subscription (agent panes and terminals),
   *  with the conversation it last named. */
  private readonly sessions = new Map<string, PaneSession | undefined>()
  /** The live agent panes, as of the last listing. */
  private agentPanes = new Set<string>()
  private readonly readSessions: () => Promise<WatchedSession[]>
  /** The `tui` sessions' tools by window, as last read. */
  private sessionTools = new Map<string, AgentTool>()

  constructor(session: DrivenWorkspace, sink: (obs: AgentObservation) => void, deps: AgentConnectDeps) {
    super(session, sink, deps, 'tui-driver')
    this.readSessions = deps.sessions ?? (() => Promise.resolve([]))
    this.start()
  }

  /**
   * List panes and subscribe their formats. The first pane of each `tui`
   * session's window is its agent and gets status, report and death
   * subscriptions; the rest do not. Every pane gets the session
   * subscription, which records conversations started by hand in a
   * terminal.
   *
   * The listing includes each pane's current session value, since a
   * subscription's first push may lag up to a second.
   *
   * Re-run on each heartbeat, window add or close, and agent exit.
   * Already-subscribed panes are skipped.
   */
  protected async sync(): Promise<void> {
    // Tab-separated: names and paths can contain spaces, and the session
    // format strips tabs.
    const [listed, sessions] = await Promise.all([
      this.send(`list-panes -s -F '#{pane_id}\t#{window_name}\t#{pane_dead}\t${PANE_SESSION_FORMAT}' -t yaac`),
      this.readSessions().catch(() => undefined),
    ])
    if (this.done) return
    if (sessions !== undefined) {
      this.sessionTools = new Map(sessions.filter((s) => s.mode === 'tui').map((s) => [s.window, s.tool]))
    }

    const seenWindows = new Set<string>()
    const panes = listed.split('\n')
      .map((line) => line.split('\t'))
      .flatMap(([paneId, windowName = '', dead, session]): ListedPane[] => {
        if (paneId === undefined || !paneId.startsWith('%')) return []
        const tool = seenWindows.has(windowName) ? undefined : this.sessionTools.get(windowName)
        seenWindows.add(windowName)
        return [{
          paneId,
          ...(tool !== undefined ? { tool, window: windowName } : {}),
          dead: dead === '1',
          session: parsePaneSession(session ?? ''),
        }]
      })

    // Read only unwatched panes from the listing (a watched pane's pushes
    // are newer), all before any await so a push arriving meanwhile wins.
    const unwatched = new Set(panes.filter((p) => !this.sessions.has(p.paneId)).map((p) => p.paneId))
    for (const { paneId, session } of panes) if (unwatched.has(paneId)) this.sessions.set(paneId, session)
    this.agentPanes = new Set(panes.filter((p) => p.tool !== undefined && !p.dead).map((p) => p.paneId))
    for (const { paneId, tool, window, dead } of panes) {
      if (unwatched.has(paneId)) {
        await this.send(`refresh-client -B '${subscriptionName(SESSION_SUBSCRIPTION_PREFIX, paneId)}:${paneId}:${PANE_SESSION_FORMAT}'`)
        if (this.done) return
      }
      if (tool === undefined || window === undefined) continue
      await this.watchPaneDeath(paneId)
      if (this.done) return
      if (dead || this.subscribed.has(paneId)) continue
      // Single-quote the -B argument: tmux processes C escapes inside double
      // quotes, which would corrupt an ERE `\b`. The format never contains
      // `'`.
      await this.send(`refresh-client -B '${subscriptionName(SUBSCRIPTION_PREFIX, paneId)}:${paneId}:${agentStatusFormat(tool)}'`)
      if (this.done) return
      await this.send(`refresh-client -B '${subscriptionName(REPORT_SUBSCRIPTION_PREFIX, paneId)}:${paneId}:${agentReportFormat(tool)}'`)
      if (this.done) return
      this.subscribed.set(paneId, { tool, window })
    }
    const liveIds = new Set(panes.map((p) => p.paneId))
    for (const paneId of [...this.sessions.keys()]) {
      if (liveIds.has(paneId)) continue
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
   * The live set: every session's agent, under its window, plus any other
   * pane naming a conversation, under its pane id, with its latest reports.
   */
  private publishAgents(): void {
    const agents: LiveAgent[] = []
    for (const [paneId, session] of this.sessions) {
      const agent = this.agentPanes.has(paneId) ? this.subscribed.get(paneId) : undefined
      const tool = agent?.tool ?? session?.tool
      if (tool === undefined) continue
      // Only its own tool's conversation: a pane keeps its options across a
      // respawn, which may run another tool.
      const own = session?.tool === tool ? session : undefined
      if (agent === undefined && own === undefined) continue
      const model = this.models.get(paneId)
      const reportedMode = this.modes.get(paneId)
      const reportedEffort = this.efforts.get(paneId)
      agents.push({
        handle: agent?.window ?? paneId,
        tool,
        ...(own !== undefined ? { conversationId: own.conversationId } : {}),
        ...(own?.transcriptPath !== undefined ? { transcriptPath: own.transcriptPath } : {}),
        ...(agent !== undefined && model !== undefined ? { model } : {}),
        ...(agent !== undefined && reportedMode !== undefined ? { reportedMode } : {}),
        ...(agent !== undefined && reportedEffort !== undefined ? { reportedEffort } : {}),
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
   * conversation registry joins against on its reconcile pass. Empty keeps
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
    const agent = this.subscribed.get(n.paneId)
    if (agent === undefined || !this.agentPanes.has(n.paneId)) return
    if (n.name.startsWith(REPORT_SUBSCRIPTION_PREFIX)) {
      const { model, mode, effort } = splitAgentReport(n.value)
      this.onReport(n.paneId, mode, effort)
      void this.onModel(n.paneId, agent.tool, model)
      return
    }
    if (!n.name.startsWith(SUBSCRIPTION_PREFIX)) return
    this.sink({
      kind: 'status',
      handle: agent.window,
      status: classifyAgentObservation(agent.tool, n.value),
    })
  }

  protected cleanup(): void {
    this.subscribed.clear()
    this.models.clear()
    this.modelPushes.clear()
    this.modes.clear()
    this.efforts.clear()
    this.sessions.clear()
    this.agentPanes.clear()
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
      workspaceId: spec.conversationId,
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
    // A session's handle is its window, which pastes into the window's
    // active pane; a terminal's agent is addressed by its pane id.
    const target = handle.startsWith('%') ? handle : windowTarget(handle)
    const driver = workspaceDriver()
    const paths = driver.workspacePaths(session.jobName)
    if (opts.running === undefined) {
      const { cmd, stdin } = buildPromptPasteBgCmd(target, text, paths)
      await driver.exec(session.jobName, cmd, { maxAttempts: 1, timeout: 15_000, stdin })
      return
    }
    const { cmd, stdin } = buildMessageCmd(target, text, paths, opts.running)
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
