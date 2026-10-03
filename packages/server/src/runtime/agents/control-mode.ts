/**
 * Minimal tmux control-mode (`tmux -C`) client. Two kinds of stream use it,
 * one of each per workspace:
 * - the status watcher's, in both agent modes: notifications push state
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

import type { WorkspacePaths } from '#drivers/contract'

/**
 * The in-workspace control-mode attach argv, dialed as a ctrl stream. Flags:
 * `read-only` (never inject input), `ignore-size` (never reshape the grid a
 * content search reads), `no-output` (state comes only from subscriptions
 * and notifications).
 */
export function controlModeAttachArgv(paths: WorkspacePaths): string[] {
  return [
    'tmux', '-S', paths.tmuxSock, '-C', 'attach-session', '-t', 'yaac',
    '-f', 'read-only,ignore-size,no-output',
  ]
}

/**
 * `1` while a pane still runs the session's `sleep infinity` keepalive
 * (some tmux versions quote the start command). An agent respawned into
 * the pane announces nothing, so a driver subscribes to this to learn when
 * the agent has replaced it.
 */
export const PLACEHOLDER_FORMAT = '#{m/r:^"?sleep infinity"?$,#{pane_start_command}}'

/** Reject `promise` if it has not settled within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
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
  /** A window was added or closed (`closedWindowId` names a closed one);
   *  the driver re-lists agents, since a new conversation arrives as a new
   *  window. */
  | { kind: 'windows-changed'; closedWindowId?: string }
  | { kind: 'exit' }

/**
 * Parse one notification line (a `%` line outside a reply block). Returns
 * null for notifications the watchers ignore and for non-`%` noise.
 */
export function parseControlModeNotification(line: string): ControlModeNotification | null {
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
  if (line.startsWith('%window-add')) return { kind: 'windows-changed' }
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
