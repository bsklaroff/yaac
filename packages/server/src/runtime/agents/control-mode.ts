/**
 * Minimal tmux control-mode (`tmux -C`) client. The status watchers hold one
 * persistent stream per workspace (in both agent modes), used both ways:
 * - notifications push state (`%subscription-changed` carries the
 *   subscribed format's value; `%output` is parsed but unused, since the
 *   watchers attach `no-output`);
 * - commands go over the same connection (`send()` resolves with the
 *   `%begin`/`%end` reply body), so the heartbeat needs no extra exec.
 *
 * Protocol facts (tmux 3.4, as in the workspace image):
 * - On attach tmux emits one unsolicited reply block, consumed as a banner
 *   so FIFO reply matching stays aligned.
 * - Replies are `%begin <ts> <num> <flags>` … body … `%end|%error`;
 *   notifications never appear inside a block.
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
  | { kind: 'output'; paneId: string }
  /** A window was added or closed; the driver re-lists agents, since a new
   *  conversation arrives as a new window. */
  | { kind: 'windows-changed' }
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
    const paneId = line.slice('%output '.length).split(' ')[0]
    if (!paneId?.startsWith('%')) return null
    return { kind: 'output', paneId }
  }
  if (line === '%exit' || line.startsWith('%exit ')) return { kind: 'exit' }
  // `%unlinked-window-close` is for a window in no session this client is
  // attached to; either close may mean an agent window went away.
  if (line.startsWith('%window-add')
    || line.startsWith('%window-close')
    || line.startsWith('%unlinked-window-close')) {
    return { kind: 'windows-changed' }
  }
  return null
}

interface PendingReply {
  resolve: (body: string) => void
  reject: (err: Error) => void
}

export class ControlModeClient {
  private buffer = ''
  private inReply = false
  private replyLines: string[] = []
  private bannerSeen = false
  private failed: Error | null = null
  private readonly pending: PendingReply[] = []

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
    if (this.failed) return Promise.reject(this.failed)
    return new Promise<string>((resolve, reject) => {
      this.pending.push({ resolve, reject })
      try {
        this.write(`${command}\n`)
      } catch (err) {
        this.pending.pop()
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
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
    if (this.inReply) {
      if (line.startsWith('%end ') || line === '%end') {
        this.finishReply(null)
      } else if (line.startsWith('%error ') || line === '%error') {
        this.finishReply(new Error(this.replyLines.join('\n') || 'tmux command failed'))
      } else {
        this.replyLines.push(line)
      }
      return
    }
    if (line.startsWith('%begin ') || line === '%begin') {
      this.inReply = true
      this.replyLines = []
      return
    }
    const n = parseControlModeNotification(line)
    if (n) this.onNotification(n)
  }

  private finishReply(err: Error | null): void {
    this.inReply = false
    const body = this.replyLines.join('\n')
    this.replyLines = []
    // The implicit attach reply predates any command we sent.
    if (!this.bannerSeen) {
      this.bannerSeen = true
      return
    }
    const p = this.pending.shift()
    if (!p) return
    if (err) p.reject(err)
    else p.resolve(body)
  }
}
