/**
 * The webapp's terminals (docs/terminal-mirror.md). Each `agent` or
 * `window:@<id>` attach is a viewer of one tmux pane, served through one
 * read-write tmux control-mode client per workspace. A viewer is sent the
 * pane's size, then a snapshot seeded from tmux, then the pane's raw
 * output, so the browser's own xterm holds the scrollback and scrolls it
 * without a round trip. Input goes back to the pane through tmux.
 *
 * tmux stays the only terminal state: nothing here emulates a terminal.
 */

import { workspaceDriver } from '#drivers/driver'
import { ControlModeClient, type ControlModeNotification } from '#runtime/agents'
import { serverLog } from '#log'
import { createOutputBatcher, type OutputBatcher } from '@yaac/shared/batcher'
import { parseControl, pongFor, toBytes, type SocketLike } from './socket'
import type { StreamChild } from '#drivers/contract'

/** History lines a snapshot carries above the screen. Older history stays
 *  in tmux. */
const SEED_HISTORY_LINES = 5000
/** Input bytes per `send-keys -H` command, to keep command lines short. */
const SEND_KEYS_CHUNK = 512
/** A viewer's queued bytes past which its output is dropped, to be
 *  replaced by one fresh snapshot once the queue drains below
 *  `DRAIN_LOW_WATER`. */
export const FLOOD_HIGH_WATER = 4 * 1024 * 1024
const DRAIN_LOW_WATER = 256 * 1024
const DRAIN_CHECK_MS = 200
/** How long a workspace's control client outlives its last viewer, so
 *  switching tabs or reconnecting doesn't redial it. */
export const MIRROR_IDLE_MS = 30_000

const PASTE_START = Buffer.from('\x1b[200~')
const PASTE_END = Buffer.from('\x1b[201~')

/**
 * Everything a snapshot restores beyond the captured text, in this order.
 * `cursor_shape` is `block`, `underline`, `bar` or `default`.
 */
const SEED_FIELDS = [
  'pane_width', 'pane_height', 'cursor_x', 'cursor_y', 'cursor_flag',
  'alternate_on', 'alternate_saved_x', 'alternate_saved_y',
  'scroll_region_upper', 'scroll_region_lower',
  'keypad_cursor_flag', 'keypad_flag', 'insert_flag', 'wrap_flag', 'origin_flag',
  'mouse_standard_flag', 'mouse_button_flag', 'mouse_any_flag', 'mouse_sgr_flag', 'mouse_utf8_flag',
  'cursor_shape', 'cursor_blinking',
] as const
type PaneState = Record<(typeof SEED_FIELDS)[number], string>
const SEED_FORMAT = SEED_FIELDS.map((f) => `#{${f}}`).join(' ')

/** tmux escapes control bytes and `\` in `%output` as three-digit octal.
 *  The data is latin1 (one char per byte), as the stream is fed. */
function unescapeOutput(data: string): Buffer {
  return Buffer.from(data.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8))), 'latin1')
}

/** A tmux double-quoted string holding `bytes` exactly. Every byte outside
 *  printable ASCII is an octal escape, which keeps the command line ASCII
 *  whatever the stream's text encoding. `$` and `~` are escaped so tmux
 *  does not expand them (it home-expands a leading `~` even in quotes). */
function tmuxQuote(bytes: Buffer): string {
  let s = '"'
  for (const b of bytes) {
    if (b === 0x5c) s += '\\\\'
    else if (b === 0x22) s += '\\"'
    else if (b === 0x24) s += '\\$'
    else if (b < 0x20 || b >= 0x7e) s += `\\${b.toString(8).padStart(3, '0')}`
    else s += String.fromCharCode(b)
  }
  return `${s}"`
}

/** A pane's size in a `%layout-change` layout, or undefined if the pane is
 *  not in it. Leaves look like `80x24,0,0,5` for pane `%5`. */
function paneSizeInLayout(layout: string, paneId: string): { cols: number; rows: number } | undefined {
  const id = paneId.slice(1)
  for (const m of layout.matchAll(/(\d+)x(\d+),\d+,\d+,(\d+)/g)) {
    if (m[3] === id) return { cols: Number(m[1]), rows: Number(m[2]) }
  }
  return undefined
}

/** DECSCUSR for tmux's cursor shape: 0 is the terminal default; odd
 *  numbers blink. */
const CURSOR_SHAPES: Record<string, number> = { block: 1, underline: 3, bar: 5 }
function cursorStyle(shape: string, blinking: string): string {
  const base = CURSOR_SHAPES[shape]
  if (base === undefined) return '\x1b[0 q'
  return `\x1b[${base + (blinking === '1' ? 0 : 1)} q`
}

/**
 * The bytes that bring a fresh xterm to the pane's state: a full reset, the
 * captured text, then cursor and modes. Captured lines are joined with a
 * bare CR-LF, since a capture's SGR state carries from line to line.
 *
 * On the alternate screen the normal history and saved normal screen come
 * first, then the switch, then the alternate screen.
 *
 * Bracketed paste is always turned on: tmux does not expose the app's
 * setting, so the browser brackets every paste and `paste-buffer -p`
 * re-brackets only when the app asked (see `MirrorViewer.input`).
 */
function buildSnapshot(state: PaneState, normal: string[], alternate: string[] | null): Buffer {
  const on = (f: keyof PaneState): boolean => state[f] === '1'
  const cup = (y: number, x: number): string => `\x1b[${y + 1};${x + 1}H`
  let out = '\x1bc' + normal.join('\r\n')
  if (alternate) {
    out += cup(Number(state.alternate_saved_y), Number(state.alternate_saved_x))
      + '\x1b[?1049h\x1b[H' + alternate.join('\r\n')
  }
  out += '\x1b[0m'
  const upper = Number(state.scroll_region_upper)
  const lower = Number(state.scroll_region_lower)
  if (upper !== 0 || lower !== Number(state.pane_height) - 1) out += `\x1b[${upper + 1};${lower + 1}r`
  const cy = Number(state.cursor_y)
  const cx = Number(state.cursor_x)
  out += on('origin_flag') ? `\x1b[?6h${cup(cy - upper, cx)}` : cup(cy, cx)
  if (!on('wrap_flag')) out += '\x1b[?7l'
  if (on('insert_flag')) out += '\x1b[4h'
  if (on('keypad_cursor_flag')) out += '\x1b[?1h'
  if (on('keypad_flag')) out += '\x1b='
  if (on('mouse_any_flag')) out += '\x1b[?1003h'
  else if (on('mouse_button_flag')) out += '\x1b[?1002h'
  else if (on('mouse_standard_flag')) out += '\x1b[?1000h'
  if (on('mouse_sgr_flag')) out += '\x1b[?1006h'
  if (on('mouse_utf8_flag')) out += '\x1b[?1005h'
  if (!on('cursor_flag')) out += '\x1b[?25l'
  out += cursorStyle(state.cursor_shape, state.cursor_blinking)
  out += '\x1b[?2004h'
  return Buffer.from(out, 'latin1')
}

/** Output or a resize that reached a viewer while it was being seeded,
 *  with how many command replies had been read by then. */
interface HeldEvent {
  repliesSeen: number
  apply: () => void
}

class MirrorViewer {
  paneId = ''
  windowId = ''
  /** The size this viewer's own terminal wants, from its last resize. */
  size: { cols: number; rows: number } | undefined
  /** The pane size last sent to the client. */
  sentSize = ''
  /** Non-null while a seed is in flight: what to replay once it lands. */
  held: HeldEvent[] | null = null
  /** Output was dropped because the client fell behind; re-seed once its
   *  queue drains. */
  stale = false
  closed = false
  private inPaste: Buffer[] | null = null
  readonly out: OutputBatcher

  constructor(readonly sock: SocketLike, readonly target: string) {
    // Coalesce `%output` lines into one message per burst, as the PTY
    // bridge does, so a redraw paints in one frame.
    this.out = createOutputBatcher((chunk) => {
      try {
        sock.send(Buffer.from(chunk, 'latin1'))
      } catch {
        // Socket gone; its close handler removes the viewer.
      }
    })
  }

  /** Send outside the batcher, after everything it holds. */
  sendNow(data: string | Uint8Array): void {
    this.out.flush()
    try {
      this.sock.send(data)
    } catch {
      // Socket gone; its close handler removes the viewer.
    }
  }

  sendSize(cols: number, rows: number): void {
    const key = `${cols}x${rows}`
    if (key === this.sentSize) return
    this.sentSize = key
    this.sendNow(JSON.stringify({ type: 'size', cols, rows }))
  }

  /**
   * Split client input into keystrokes and bracketed pastes. A paste
   * arrives whole in one frame (xterm emits it as one data event and the
   * client's batcher never splits one), but the end marker is still
   * awaited across frames.
   */
  input(bytes: Buffer, keys: (b: Buffer) => void, paste: (b: Buffer) => void): void {
    let rest = bytes
    while (rest.length > 0) {
      if (this.inPaste) {
        const end = rest.indexOf(PASTE_END)
        if (end === -1) {
          this.inPaste.push(rest)
          return
        }
        this.inPaste.push(rest.subarray(0, end))
        paste(Buffer.concat(this.inPaste))
        this.inPaste = null
        rest = rest.subarray(end + PASTE_END.length)
        continue
      }
      const start = rest.indexOf(PASTE_START)
      if (start === -1) {
        keys(rest)
        return
      }
      if (start > 0) keys(rest.subarray(0, start))
      this.inPaste = []
      rest = rest.subarray(start + PASTE_START.length)
    }
  }
}

/** One workspace's control client and the viewers it serves. */
class WorkspaceMirror {
  private readonly viewers = new Set<MirrorViewer>()
  private readonly child: StreamChild
  private readonly client: ControlModeClient
  /** Panes whose output is switched off because nobody views them. */
  private readonly offPanes = new Set<string>()
  /** Per window, the viewer whose size the control client last applied. */
  private readonly sizedBy = new Map<string, MirrorViewer>()
  /** Whether the client's default size, for windows nobody views, is set. */
  private defaultSized = false
  private idleTimer: NodeJS.Timeout | null = null
  private drainTimer: NodeJS.Timeout | null = null
  private done = false

  constructor(private readonly jobName: string, private readonly onDone: () => void) {
    const paths = workspaceDriver().workspacePaths(jobName)
    this.child = workspaceDriver().dialCtrl(jobName, ['tmux', '-S', paths.tmuxSock, '-C', 'attach-session', '-t', 'yaac'])
    this.client = new ControlModeClient(
      (data) => this.child.stdin?.write(data),
      (n) => this.onNotification(n),
    )
    // latin1 keeps each byte one char: pane output can split a UTF-8
    // character across `%output` lines, and the browser's xterm reassembles
    // it from the raw bytes.
    this.child.stdout?.on('data', (chunk) => {
      if (!this.done) this.client.feed(typeof chunk === 'string' ? chunk : chunk.toString('latin1'))
    })
    this.child.stderr?.on('data', () => { /* the exit reports the failure */ })
    this.child.on('error', (err) => this.shutdown(`stream error: ${String(err)}`))
    this.child.on('exit', () => this.shutdown('stream closed'))
  }

  add(sock: SocketLike, target: string, size: { cols?: number; rows?: number }): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    const viewer = new MirrorViewer(sock, target)
    if (size.cols && size.rows) viewer.size = { cols: size.cols, rows: size.rows }
    this.viewers.add(viewer)
    sock.onMessage((data, isBinary) => this.onClientMessage(viewer, data, isBinary))
    sock.onClose(() => this.remove(viewer))
    void this.open(viewer).catch((err: unknown) => this.closeViewer(viewer, 1011, `attach failed: ${String(err)}`))
  }

  /** Resolve the target to its pane, size its window, and seed. */
  private async open(viewer: MirrorViewer): Promise<void> {
    // The agent is the lowest-index window (`^`), as in the terminals
    // listing.
    const window = viewer.target === 'agent' ? 'yaac:^' : viewer.target.slice('window:'.length)
    const [paneId, windowId] = (await this.client.send(`display -p -t '${window}' '#{pane_id} #{window_id}'`)).split(' ')
    if (!paneId?.startsWith('%') || !windowId?.startsWith('@')) throw new Error(`no pane for ${viewer.target}`)
    if (viewer.closed) return
    // Hold the pane's output from here: none may reach the client before
    // its snapshot.
    viewer.held = []
    viewer.paneId = paneId
    viewer.windowId = windowId
    // `latest` regardless of the user's tmux config, so the window follows
    // whichever client last resized or typed.
    await this.client.send(`set-option -w -t ${windowId} window-size latest`)
    await this.applySize(viewer)
    if (this.offPanes.delete(paneId)) await this.client.send(`refresh-client -A '${paneId}:on'`)
    await this.seed(viewer)
  }

  /**
   * Send the viewer its pane's size and snapshot, then the output held
   * meanwhile. The probe picks the captures; the seed's own state confirms
   * the screen did not switch in between, or it starts over.
   */
  private async seed(viewer: MirrorViewer): Promise<void> {
    const pane = viewer.paneId
    viewer.held ??= []
    for (;;) {
      const [alt, history] = (await this.client.send(`display -p -t ${pane} '#{alternate_on} #{history_size}'`)).split(' ')
      const captures = alt === '1'
        ? [
          ...(Number(history) > 0 ? [`capture-pane -p -e -J -S -${SEED_HISTORY_LINES} -E -1 -t ${pane}`] : []),
          `capture-pane -p -e -a -q -t ${pane}`,
          `capture-pane -p -e -t ${pane}`,
        ]
        : [`capture-pane -p -e -J -S -${SEED_HISTORY_LINES} -E - -t ${pane}`]
      // Output read before the last of these replies is in the captures.
      const seededAt = this.client.commandsSent + 1 + captures.length
      const [stateLine, ...bodies] = await this.client.sendGroup([`display -p -t ${pane} '${SEED_FORMAT}'`, ...captures])
      if (viewer.closed) return
      const values = stateLine.split(' ')
      const state = Object.fromEntries(SEED_FIELDS.map((f, i) => [f, values[i] ?? ''])) as PaneState
      if (state.alternate_on !== alt) continue
      const lines = (body: string): string[] => body.split('\n')
      const snapshot = alt === '1'
        ? buildSnapshot(state, bodies.slice(0, -1).flatMap(lines), lines(bodies[bodies.length - 1]))
        : buildSnapshot(state, lines(bodies[0]), null)
      viewer.sentSize = ''
      viewer.sendSize(Number(state.pane_width), Number(state.pane_height))
      viewer.sendNow(snapshot)
      const held = viewer.held
      viewer.held = null
      for (const h of held) if (h.repliesSeen >= seededAt) h.apply()
      return
    }
  }

  private onNotification(n: ControlModeNotification): void {
    if (n.kind === 'output') {
      const viewing = [...this.viewers].filter((v) => v.paneId === n.paneId)
      if (viewing.length === 0) {
        if (!this.offPanes.has(n.paneId) && ![...this.viewers].some((v) => v.paneId === '')) {
          this.offPanes.add(n.paneId)
          void this.client.send(`refresh-client -A '${n.paneId}:off'`).catch(() => {})
        }
        return
      }
      const data = unescapeOutput(n.data)
      for (const v of viewing) this.deliver(v, data)
    } else if (n.kind === 'layout') {
      for (const v of this.viewers) {
        if (v.windowId !== n.windowId) continue
        const size = paneSizeInLayout(n.layout, v.paneId)
        if (!size) this.closeViewer(v, 1000, 'pane closed')
        else if (v.held) v.held.push({ repliesSeen: this.client.repliesSeen, apply: () => v.sendSize(size.cols, size.rows) })
        else v.sendSize(size.cols, size.rows)
      }
    } else if (n.kind === 'windows-changed' && n.closedWindowId) {
      for (const v of this.viewers) {
        if (v.windowId === n.closedWindowId) this.closeViewer(v, 1000, 'window closed')
      }
    } else if (n.kind === 'exit') {
      this.shutdown('tmux exited')
    }
  }

  /** Forward output, or hold it during a seed, or drop it while the client
   *  is too far behind (it is re-seeded once it drains). */
  private deliver(viewer: MirrorViewer, data: Buffer): void {
    if (viewer.held) {
      viewer.held.push({ repliesSeen: this.client.repliesSeen, apply: () => this.deliver(viewer, data) })
      return
    }
    if (viewer.stale) return
    if (viewer.sock.bufferedAmount() > FLOOD_HIGH_WATER) {
      viewer.stale = true
      this.drainTimer ??= setInterval(() => this.reseedDrained(), DRAIN_CHECK_MS)
      return
    }
    viewer.out.push(data.toString('latin1'))
  }

  private reseedDrained(): void {
    const stale = [...this.viewers].filter((v) => v.stale)
    if (stale.length === 0) {
      if (this.drainTimer) clearInterval(this.drainTimer)
      this.drainTimer = null
      return
    }
    for (const v of stale) {
      if (v.sock.bufferedAmount() > DRAIN_LOW_WATER) continue
      v.stale = false
      void this.seed(v).catch((err: unknown) => this.closeViewer(v, 1011, `reseed failed: ${String(err)}`))
    }
  }

  private onClientMessage(viewer: MirrorViewer, data: string | Buffer | ArrayBuffer, isBinary: boolean): void {
    if (isBinary) {
      if (!viewer.paneId) return
      // Typing makes this client the latest, as it would a tmux client.
      if (this.sizedBy.get(viewer.windowId) !== viewer) void this.applySize(viewer).catch(() => {})
      viewer.input(toBytes(data), (keys) => this.sendKeys(viewer.paneId, keys), (text) => this.paste(viewer.paneId, text))
      return
    }
    const ctrl = parseControl(typeof data === 'string' ? data : toBytes(data).toString('utf8'))
    if (!ctrl) return
    if (ctrl.type === 'resize' && ctrl.cols && ctrl.rows) {
      viewer.size = { cols: Math.trunc(ctrl.cols), rows: Math.trunc(ctrl.rows) }
      void this.applySize(viewer).catch(() => {})
    } else if (ctrl.type === 'ping') {
      viewer.sendNow(pongFor(ctrl))
    }
    // `signal` targets a PTY's process; a mirrored pane has none here.
  }

  private sendKeys(paneId: string, bytes: Buffer): void {
    for (let i = 0; i < bytes.length; i += SEND_KEYS_CHUNK) {
      const hex = [...bytes.subarray(i, i + SEND_KEYS_CHUNK)].map((b) => b.toString(16).padStart(2, '0'))
      void this.client.send(`send-keys -t ${paneId} -H ${hex.join(' ')}`).catch(() => {})
    }
  }

  /** `-p` brackets the paste only if the app asked for it; `-r` keeps the
   *  line endings xterm already converted. */
  private paste(paneId: string, text: Buffer): void {
    void this.client.sendGroup([
      `set-buffer -b yaac-paste -- ${tmuxQuote(text)}`,
      `paste-buffer -p -r -d -b yaac-paste -t ${paneId}`,
    ]).catch(() => {})
  }

  /**
   * Size the viewer's window for this client. Sizes are per window, since
   * the webapp tiles panes of different sizes. A control client's size for
   * a window overrides other clients' outright, so it is held only while a
   * viewer is on the window (see `remove`). For every other window the
   * client's default size takes part in `window-size latest` like any
   * client's, and is 80x24 until set, so the first viewer's size becomes
   * that default.
   */
  private async applySize(viewer: MirrorViewer): Promise<void> {
    if (!viewer.size || !viewer.windowId) return
    const { cols, rows } = viewer.size
    this.sizedBy.set(viewer.windowId, viewer)
    const commands = [`refresh-client -C ${viewer.windowId}:${cols}x${rows}`]
    if (!this.defaultSized) {
      this.defaultSized = true
      commands.unshift(`refresh-client -C ${cols}x${rows}`)
    }
    await this.client.sendGroup(commands)
  }

  private closeViewer(viewer: MirrorViewer, code: number, reason: string): void {
    if (viewer.closed) return
    viewer.out.flush()
    try {
      viewer.sock.close(code, reason)
    } catch {
      // already closed
    }
    this.remove(viewer)
  }

  private remove(viewer: MirrorViewer): void {
    if (viewer.closed) return
    viewer.closed = true
    viewer.out.dispose()
    this.viewers.delete(viewer)
    // Hand the window to another viewer of it, or back to tmux's other
    // clients once nobody here views it.
    const window = viewer.windowId
    if (window && this.sizedBy.get(window) === viewer && !this.done) {
      this.sizedBy.delete(window)
      const next = [...this.viewers].reverse().find((v) => v.windowId === window && v.size)
      if (next) void this.applySize(next).catch(() => {})
      else void this.client.send(`refresh-client -C '${window}:'`).catch(() => {})
    }
    if (this.viewers.size === 0 && !this.done) {
      this.idleTimer = setTimeout(() => this.shutdown('idle'), MIRROR_IDLE_MS)
    }
  }

  /** End the control client; open viewers are closed so they reconnect to
   *  a fresh one. */
  private shutdown(why: string): void {
    if (this.done) return
    this.done = true
    if (why !== 'idle') serverLog(`[terminals] pane mirror for ${this.jobName} ended: ${why}`)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.drainTimer) clearInterval(this.drainTimer)
    this.client.fail(new Error(why))
    for (const v of [...this.viewers]) this.closeViewer(v, 1011, why)
    try {
      this.child.kill()
    } catch {
      // already gone
    }
    this.onDone()
  }
}

const mirrors = new Map<string, WorkspaceMirror>()

/** Attach one webapp terminal (`agent` or `window:@<id>`) to its pane. */
export function attachMirroredPane(
  jobName: string,
  socket: SocketLike,
  target: string,
  size: { cols?: number; rows?: number },
): void {
  let mirror = mirrors.get(jobName)
  if (!mirror) {
    const created: WorkspaceMirror = new WorkspaceMirror(jobName, () => {
      if (mirrors.get(jobName) === created) mirrors.delete(jobName)
    })
    mirror = created
    mirrors.set(jobName, mirror)
  }
  mirror.add(socket, target, size)
}
