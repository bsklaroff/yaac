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
 * A conversation's handle here is its tmux pane id (`%3`). Which conversation
 * a pane has loaded is deliberately not known — that is the in-pod hook's
 * session-starts log to answer, and the registry joins the two.
 */

import { StringDecoder } from 'node:string_decoder'
import { type StreamChild, type WorkspacePaths } from '#drivers/contract'
import { serverLog } from '#log'
import { ControlModeClient, type ControlModeNotification } from './control-mode'
import { agentStatusFormat, agentWindowTool, classifyAgentObservation } from './agent-tools'
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
function subscriptionName(paneId: string): string {
  return `${SUBSCRIPTION_PREFIX}${paneId.replace('%', '')}`
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
   * Enumerate the panes running an agent and subscribe a status format on
   * each. An agent pane is one whose window is an agent window — `<tool>` for
   * the worktree's original agent, `<tool>-2`, `<tool>-3`, … for the extra
   * conversations a restart brings back or a user opens. Init windows and
   * scratch shells are deliberately excluded: they have no agent status.
   *
   * Re-run on every heartbeat and on window add/close, so a conversation
   * opened (or closed) mid-session is picked up without a reconnect. Already
   * subscribed panes are skipped, since re-subscribing the same pane under the
   * same name would just duplicate pushes.
   */
  private async syncPanes(): Promise<void> {
    const listed = await this.send("list-panes -s -F '#{pane_id} #{window_name}' -t yaac")
    if (this.done) return

    const panes = listed.split('\n')
      .map((line) => line.trim().split(' '))
      .flatMap(([paneId, windowName]) => {
        if (paneId === undefined || !paneId.startsWith('%') || windowName === undefined) return []
        const paneTool = agentWindowTool(windowName)
        // Classify each pane against ITS tool's grammar, not the worktree's: a
        // pi pane read with claude's title format is permanently misclassified.
        return paneTool === undefined ? [] : [{ paneId, tool: paneTool }]
      })

    if (panes.length === 0) {
      // Nothing to classify yet (the agent window is still being created).
      // Deliberately not published as an empty live set: that would read as
      // "every agent exited" and deactivate the worktree's conversations.
      return
    }

    for (const { paneId, tool } of panes) {
      if (this.subscribed.has(paneId)) continue
      // Single-quote the -B argument: tmux processes C escapes (`\b`, `\t`, …)
      // inside double quotes, which would corrupt an ERE word boundary in the
      // status format; single quotes carry the format string literally. Safe
      // because the format literal never contains a `'` (a pane title's runtime
      // value is expanded later, per-client — it's not on this command line).
      await this.send(`refresh-client -B '${subscriptionName(paneId)}:${paneId}:${agentStatusFormat(tool)}'`)
      if (this.done) return
      this.subscribed.set(paneId, tool)
    }
    const liveIds = panes.map((p) => p.paneId)
    for (const paneId of [...this.subscribed.keys()]) {
      if (!liveIds.includes(paneId)) this.subscribed.delete(paneId)
    }
    const agents: LiveAgent[] = panes.map((p) => ({ handle: p.paneId, tool: p.tool }))
    this.sink({ kind: 'live-agents', agents })
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
      const tool = this.subscribed.get(n.paneId)
      if (!n.name.startsWith(SUBSCRIPTION_PREFIX) || tool === undefined) return
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
