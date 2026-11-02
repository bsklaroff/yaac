/**
 * Minimal tmux control-mode (`tmux -C`) client. Two kinds of stream use it,
 * one of each per workspace:
 * - the status watcher's, in both agent modes (`ControlModeConnection`,
 *   which both agent drivers extend): notifications push state
 *   (`%subscription-changed` carries the subscribed format's value; the
 *   watchers attach `no-output`), and commands go over the same connection
 *   (`send()` resolves with the `%begin`/`%end` reply body), so the
 *   heartbeat needs no extra exec;
 * - the webapp terminals' pane mirror (`#runtime/terminals`), which reads
 *   `%output` and `%layout-change` and seeds from command replies. It feeds
 *   the stream as latin1, one char per byte, since a pane's output can split
 *   a UTF-8 character across two `%output` lines.
 *
 * Protocol facts (tmux 3.4, as in the workspace image):
 * - On attach tmux emits one unsolicited reply block, consumed as a banner
 *   so FIFO reply matching stays aligned.
 * - Replies are `%begin <ts> <num> <flags>` … body … `%end|%error` with
 *   the same `<ts> <num> <flags>`, which is what ends a block: a body line
 *   (captured pane text) can itself start with `%end`. Notifications never
 *   appear inside a block.
 * - `%subscription-changed name $sid @wid widx %pane … : value`: the value
 *   follows the first ` : ` and may contain colons; header tokens have no
 *   spaces.
 * - Subscriptions are checked about once a second, and the current value
 *   arrives at the first check, giving an initial classification.
 */

import { StringDecoder } from 'node:string_decoder'
import type { StreamChild, WorkspacePaths } from '#drivers/contract'
import { workspaceDriver } from '#drivers/driver'
import { serverLog } from '#lib/log'
import type { AgentConnectDeps, AgentConnection, AgentObservation, DrivenWorkspace } from './drivers'
import type { WorkspaceWindow } from '#drivers/contract'

/**
 * The in-workspace control-mode attach argv, dialed as a ctrl stream. Flags:
 * `ignore-size` (never reshape the grid a content search reads), `no-output`
 * (state comes only from subscriptions and notifications). Not `read-only`:
 * from tmux 3.7, a `send-keys` run from the command line is refused while
 * any read-only client is attached, which would stop every prompt and
 * message yaac types into a pane.
 */
function controlModeAttachArgv(paths: WorkspacePaths): string[] {
  return [
    'tmux', '-S', paths.tmuxSock, '-C', 'attach-session', '-t', 'yaac',
    '-f', 'ignore-size,no-output',
  ]
}

/** Reject `promise` if it has not settled within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (err: unknown) => { clearTimeout(timer); reject(err instanceof Error ? err : new Error(String(err))) },
    )
  })
}

export type ControlModeNotification =
  | { kind: 'subscription'; name: string; paneId: string; value: string }
  /** Pane output, still escaped as tmux sends it (control bytes and `\` as
   *  three-digit octal). */
  | { kind: 'output'; paneId: string; data: string }
  /** A window's layout, and so its panes' sizes, changed. */
  | { kind: 'layout'; windowId: string; layout: string }
  /** A window was added, closed or renamed (`closedWindowId` names a
   *  closed one); the driver re-lists agents, since a new conversation
   *  arrives as a new window. */
  | { kind: 'windows-changed'; closedWindowId?: string }
  | { kind: 'exit' }

/**
 * Parse one notification line (a `%` line outside a reply block). Returns
 * null for notifications the watchers ignore and for non-`%` noise.
 */
function parseControlModeNotification(line: string): ControlModeNotification | null {
  if (line.startsWith('%subscription-changed ')) {
    const rest = line.slice('%subscription-changed '.length)
    const sep = rest.indexOf(' : ')
    if (sep === -1) return null
    const header = rest.slice(0, sep).split(' ')
    const name = header[0]
    const paneId = header.find((t) => t.startsWith('%'))
    if (!name || !paneId) return null
    return { kind: 'subscription', name, paneId, value: rest.slice(sep + 3) }
  }
  if (line.startsWith('%output ')) {
    const rest = line.slice('%output '.length)
    const sep = rest.indexOf(' ')
    const paneId = sep === -1 ? rest : rest.slice(0, sep)
    if (!paneId.startsWith('%')) return null
    return { kind: 'output', paneId, data: sep === -1 ? '' : rest.slice(sep + 1) }
  }
  if (line.startsWith('%layout-change ')) {
    const [windowId, layout] = line.slice('%layout-change '.length).split(' ')
    if (!windowId?.startsWith('@') || !layout) return null
    return { kind: 'layout', windowId, layout }
  }
  if (line === '%exit' || line.startsWith('%exit ')) return { kind: 'exit' }
  if (line.startsWith('%window-add') || line.startsWith('%window-renamed')) return { kind: 'windows-changed' }
  // `%unlinked-window-close` is for a window in no session this client is
  // attached to; either close may mean an agent window went away.
  if (line.startsWith('%window-close ') || line.startsWith('%unlinked-window-close ')) {
    return { kind: 'windows-changed', closedWindowId: line.split(' ')[1] }
  }
  return null
}

interface PendingReply {
  resolve: (body: string) => void
  reject: (err: Error) => void
  /** Commands after this one on the same line, which tmux skips if this
   *  one fails. */
  groupRest: number
}

export class ControlModeClient {
  private buffer = ''
  /** The open reply block's `<ts> <num> <flags>`, or null outside one. */
  private replyTag: string | null = null
  private replyLines: string[] = []
  private bannerSeen = false
  private failed: Error | null = null
  private readonly pending: PendingReply[] = []
  /** Replies to sent commands finished so far. Counted as each `%end`
   *  is read, before any later line, so a notification handler can tell
   *  which replies preceded it (a `send()` promise settles a microtask
   *  later). */
  repliesSeen = 0
  /** Commands written so far; the reply to the next one is number
   *  `commandsSent + 1`. */
  commandsSent = 0

  constructor(
    private readonly write: (data: string) => void,
    private readonly onNotification: (n: ControlModeNotification) => void,
  ) {}

  /**
   * Write a command down the stream and resolve with its reply body
   * (joined lines, no trailing newline). Rejects on `%error` replies
   * and when `fail()` tears the client down. Replies are matched FIFO;
   * a reply with nothing pending (tmux-initiated) is dropped.
   */
  send(command: string): Promise<string> {
    return this.sendGroup([command]).then(([body]) => body)
  }

  /**
   * Write several commands as one line, which tmux runs back to back with
   * no pane output read in between, and resolve with each reply body. tmux
   * replies to each command separately, and skips the rest of the line
   * after a failing one, so a failure rejects the group.
   */
  sendGroup(commands: string[]): Promise<string[]> {
    if (this.failed) return Promise.reject(this.failed)
    const replies = commands.map((_, i) => new Promise<string>((resolve, reject) => {
      this.pending.push({ resolve, reject, groupRest: commands.length - 1 - i })
    }))
    try {
      this.write(`${commands.join(' ; ')}\n`)
      this.commandsSent += commands.length
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      for (const p of this.pending.splice(this.pending.length - commands.length)) p.reject(e)
    }
    // Members after a failing one reject too; only the first rejection is
    // reported.
    for (const r of replies) r.catch(() => {})
    return Promise.all(replies)
  }

  /** Feed raw stream chunks; drives replies and notifications. */
  feed(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const nl = this.buffer.indexOf('\n')
      if (nl === -1) break
      let line = this.buffer.slice(0, nl)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      this.buffer = this.buffer.slice(nl + 1)
      this.handleLine(line)
    }
  }

  /** Reject every in-flight `send()`; further sends fail immediately. */
  fail(err: Error): void {
    if (this.failed) return
    this.failed = err
    for (const p of this.pending.splice(0)) p.reject(err)
  }

  private handleLine(line: string): void {
    if (this.replyTag !== null) {
      if (line === `%end${this.replyTag}`) {
        this.finishReply(null)
      } else if (line === `%error${this.replyTag}`) {
        this.finishReply(new Error(this.replyLines.join('\n') || 'tmux command failed'))
      } else {
        this.replyLines.push(line)
      }
      return
    }
    if (line.startsWith('%begin ') || line === '%begin') {
      this.replyTag = line.slice('%begin'.length)
      this.replyLines = []
      return
    }
    const n = parseControlModeNotification(line)
    if (n) this.onNotification(n)
  }

  private finishReply(err: Error | null): void {
    this.replyTag = null
    const body = this.replyLines.join('\n')
    this.replyLines = []
    // The implicit attach reply predates any command we sent.
    if (!this.bannerSeen) {
      this.bannerSeen = true
      return
    }
    const p = this.pending.shift()
    if (!p) return
    this.repliesSeen++
    if (!err) {
      p.resolve(body)
      return
    }
    p.reject(err)
    // tmux sends no reply for the skipped rest of the line.
    for (const skipped of this.pending.splice(0, p.groupRest)) {
      this.repliesSeen++
      skipped.reject(err)
    }
  }
}

/** Per session pane: whether its agent has exited (`#{pane_dead}`; session
 *  windows keep their pane with `remain-on-exit`), so an exit, and a resume
 *  that brings the pane back (`respawn-window -k` keeps its id and sends no
 *  window notification), re-list at once rather than at the next
 *  heartbeat. */
const DEAD_SUBSCRIPTION_PREFIX = 'dead-'

/**
 * What the `tui` and `acp` connections share: one persistent control-mode
 * client per workspace, dialed as a ctrl stream, which carries both the
 * driver's tmux commands and tmux's pushes. Owns the dial, decoding, the
 * command timeout, the heartbeat that detects a wedged stream, the window
 * and pane-death notifications that trigger a re-list, and teardown. A
 * subclass says what a re-list does (`sync`) and what else a heartbeat
 * checks.
 *
 * A subclass calls `start()` at the end of its constructor, once its own
 * fields exist, since a failed dial tears down synchronously.
 */
export abstract class ControlModeConnection implements AgentConnection {
  protected done = false
  protected readonly log: (msg: string) => void
  protected readonly dial: (session: DrivenWorkspace, argv: string[]) => StreamChild
  private child: StreamChild | null = null
  private client: ControlModeClient | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private heartbeatInFlight = false
  /** Panes with a death subscription (`watchPaneDeath`), with the last
   *  value it reported. */
  private readonly deathWatched = new Map<string, string | undefined>()
  private readonly heartbeatIntervalMs: number
  protected readonly commandTimeoutMs: number

  constructor(
    readonly session: DrivenWorkspace,
    protected readonly sink: (obs: AgentObservation) => void,
    deps: AgentConnectDeps,
    private readonly label: string,
  ) {
    this.heartbeatIntervalMs = deps.heartbeatIntervalMs ?? 20_000
    this.commandTimeoutMs = deps.commandTimeoutMs ?? 10_000
    this.log = deps.log ?? serverLog
    this.dial = deps.dial ?? ((s, argv) => workspaceDriver().dialCtrl(s.jobName, argv))
  }

  /** Reconcile with the workspace's windows; run at attach, on every
   *  heartbeat and on each window or pane-death notification. */
  protected abstract sync(): Promise<void>
  /** A subscription push other than a death one. */
  protected abstract onSubscription(n: Extract<ControlModeNotification, { kind: 'subscription' }>): void
  /** Release what the subclass holds; the stream is already gone. */
  protected abstract cleanup(): void
  /** Setup before the first re-list. */
  protected init(): Promise<void> {
    return Promise.resolve()
  }

  /** Subscribe to a session pane's death, once per pane. */
  protected async watchPaneDeath(paneId: string): Promise<void> {
    if (this.deathWatched.has(paneId)) return
    this.deathWatched.set(paneId, undefined)
    await this.send(`refresh-client -B '${DEAD_SUBSCRIPTION_PREFIX}${paneId.replace('%', '')}:${paneId}:#{pane_dead}'`)
  }

  /** Extra work on each heartbeat, before the re-list. */
  protected beforeHeartbeat(): void {}

  protected start(): void {
    let child: StreamChild
    try {
      child = this.dial(this.session, controlModeAttachArgv(workspaceDriver().workspacePaths(this.session.jobName)))
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
    // Chunks can split multi-byte characters (e.g. claude's Braille
    // spinner), which would corrupt titles and flip a classification.
    const decoder = new StringDecoder('utf8')
    child.stdout?.on('data', (chunk) => {
      if (!this.done) client.feed(typeof chunk === 'string' ? chunk : decoder.write(chunk))
    })
    child.stderr?.on('data', () => { /* no stderr on ctrl streams — exit logs */ })
    child.on('error', (err) => this.down(`child error: ${String(err)}`))
    child.on('exit', () => this.down('stream closed'))
    void this.establish().catch((err: unknown) => this.down(`init failed: ${String(err)}`))
  }

  /** Run one tmux command over the stream, with the reply deadline. */
  protected send(cmd: string): Promise<string> {
    const client = this.client
    if (!client) return Promise.reject(new Error('control stream torn down'))
    return withTimeout(client.send(cmd), this.commandTimeoutMs, `tmux ${cmd.split(' ')[0]}`)
  }

  /** Re-list off the hot path, ignoring failures; the heartbeat detects a
   *  wedged stream. */
  protected async resync(): Promise<void> {
    if (this.done) return
    try {
      await this.sync()
    } catch { /* the heartbeat handles wedges */ }
  }

  private async establish(): Promise<void> {
    await this.init()
    await this.sync()
    if (this.done) return
    this.sink({ kind: 'up' })
    this.sink({ kind: 'command-channel', send: (cmd) => this.send(cmd) })
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), this.heartbeatIntervalMs)
  }

  /**
   * Wedge detector: a command over the open stream whose reply proves the
   * path to the tmux server, then a re-list, which also catches windows
   * that came and went between notifications. A failure of either tears
   * the stream down, so a connection whose re-list keeps failing redials
   * rather than staying up with nothing attached.
   */
  private async heartbeat(): Promise<void> {
    if (this.done || this.heartbeatInFlight) return
    this.heartbeatInFlight = true
    try {
      this.beforeHeartbeat()
      await this.send('display-message -p ok')
      if (!this.done) await this.sync()
    } catch (err) {
      this.down(`heartbeat failed: ${String(err)}`)
    } finally {
      this.heartbeatInFlight = false
    }
  }

  private onNotification(n: ControlModeNotification): void {
    if (this.done) return
    if (n.kind === 'windows-changed') {
      this.sink({ kind: 'windows-changed' })
      void this.resync()
    } else if (n.kind === 'subscription') {
      if (!n.name.startsWith(DEAD_SUBSCRIPTION_PREFIX)) this.onSubscription(n)
      else this.onPaneDeathValue(`%${n.name.slice(DEAD_SUBSCRIPTION_PREFIX.length)}`, n.value)
    }
    // `exit`: tmux is detaching us, and the child exit that follows tears
    // down. `%output` never arrives, since connections attach no-output.
  }

  /** A dead pane re-lists, and so does one whose state changed since it
   *  last reported; the first report of a live pane is its subscribing. */
  private onPaneDeathValue(paneId: string, value: string): void {
    const last = this.deathWatched.get(paneId)
    this.deathWatched.set(paneId, value)
    if (value === '1' || (last !== undefined && last !== value)) void this.resync()
  }

  protected down(reason: string): void {
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
    this.deathWatched.clear()
    this.child?.kill('SIGTERM')
    this.child = null
    this.cleanup()
  }

  close(): void {
    if (this.done) return
    this.log(`[server] ${this.label} ${this.session.workspaceId}: closing`)
    this.teardown()
  }
}

/** Every pane, so a window's `dead` is its first pane's, the one its
 *  agent runs in, whichever pane is active. The name stays last — it may
 *  contain pipes. */
const LIST_PANES = "list-panes -s -t yaac -F '#{window_id}|#{pane_dead}|#{window_name}'"
const PANE_LINE = /^(@\d+)\|([01])\|(.*)$/

/**
 * List a workspace's tmux windows: its sessions', its terminals and the
 * keeper that holds the tmux server open. `tmux` runs one read-only tmux
 * command and returns its output: the status watcher passes its
 * control-mode stream, which costs no exec.
 */
export async function listWindows(
  tmux: (tmuxArgs: string) => Promise<string>,
): Promise<WorkspaceWindow[]> {
  const windows = new Map<string, WorkspaceWindow>()
  for (const line of (await tmux(LIST_PANES)).split('\n')) {
    const m = PANE_LINE.exec(line.trim())
    if (m && !windows.has(m[1])) windows.set(m[1], { id: m[1], name: m[3], dead: m[2] === '1' })
  }
  return [...windows.values()]
}
