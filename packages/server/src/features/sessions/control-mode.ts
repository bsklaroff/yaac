/**
 * Minimal tmux control-mode (`tmux -C`) protocol client, used by the
 * status watchers to hold one persistent stream per session pod.
 *
 * The stream is both channels at once:
 * - notifications push state at us (`%subscription-changed` carries the
 *   subscribed status format's value inline; `%output` — a pane's raw
 *   redraw bytes — is parsed but unused, since the watchers attach
 *   `no-output`),
 * - commands ride the same connection (`send()` writes a command line
 *   and resolves with the `%begin`/`%end`-framed reply body), which is
 *   what makes the heartbeat free of extra execs.
 *
 * Protocol facts this encodes (verified against tmux 3.4, the version
 * in the session image):
 * - On attach the server emits one unsolicited reply block (the
 *   implicit attach command) before anything else — consumed as the
 *   banner so FIFO reply-matching can't misalign.
 * - Replies are `%begin <ts> <num> <flags>` … body … `%end|%error` with
 *   the same fields; notifications never interleave inside a block.
 * - `%subscription-changed name $sid @wid widx %pane … : value` — the
 *   value (a pane title here) follows the first ` : ` and may itself
 *   contain colons; the header tokens never contain spaces.
 * - Subscribed formats are checked on tmux's ~1s cadence: the current
 *   value arrives at the first check after subscribing (no change
 *   needed), so a watcher gets an initial classification for free.
 */

export type ControlModeNotification =
  | { kind: 'subscription'; name: string; paneId: string; value: string }
  | { kind: 'output'; paneId: string }
  | { kind: 'exit' }

/**
 * Parse one notification line (a `%`-prefixed line outside any reply
 * block). Returns null for notifications the watchers don't consume
 * (`%session-changed`, `%layout-change`, …) and for non-`%` noise.
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
