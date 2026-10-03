/**
 * `attachPty`. Nothing in runtime/terminals is mocked; the fakes are the
 * driver's streams: `dialCtrl` is a scripted tmux control-mode client for
 * the webapp's targets (the pane mirror), `dialPty` the in-workspace PTY
 * and `exec` the one-shot tmux commands for the CLI's targets.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { attachPty, type SocketLike } from '#runtime/terminals'
import { DETACH_GRACE_MS } from '#runtime/terminals/pty-bridge'
import { FLOOD_HIGH_WATER, MIRROR_IDLE_MS } from '#runtime/terminals/pane-mirror'
import { installFakeWorkspaceDriver } from '@yaac/test-utils/fake-driver'
import { BATCH_MS } from '@yaac/shared/batcher'
import type { StreamChild, StreamPty, WorkspaceDriver } from '#drivers/contract'

const execMock = vi.fn<WorkspaceDriver['exec']>()
const dialPtyMock = vi.fn<WorkspaceDriver['dialPty']>()
const dialCtrlMock = vi.fn<WorkspaceDriver['dialCtrl']>()

const TMUX = 'tmux -S /tmp/yaac-tmux/server'
const LIST_SESSIONS = `${TMUX} list-sessions -F '#{session_name}'`

/** The live-view registry and the pane mirrors are server-wide, so tests
 *  that must not see each other's use different workspace ids. */
const sid = (n: number): string => `0f9b2c4d-1111-2222-3333-4444555566${String(n).padStart(2, '0')}`
const job = (n: number): string => `yaac-demo-${sid(n)}`

class FakePty implements StreamPty {
  written: string[] = []
  resized: Array<[number, number]> = []
  killed: Array<string | undefined> = []
  private dataCb?: (d: string) => void
  private exitCb?: (e: { exitCode: number }) => void
  onData(cb: (d: string) => void): void { this.dataCb = cb }
  onExit(cb: (e: { exitCode: number }) => void): void { this.exitCb = cb }
  write(d: string): void { this.written.push(d) }
  resize(c: number, r: number): void { this.resized.push([c, r]) }
  kill(s?: string): void { this.killed.push(s) }
  emitData(d: string): void { this.dataCb?.(d) }
  emitExit(code: number): void { this.exitCb?.({ exitCode: code }) }
}

class FakeSock implements SocketLike {
  sent: Array<string | Uint8Array> = []
  closed: Array<[number | undefined, string | undefined]> = []
  /** Simulate a vanished client: `ws` throws on a send to a closed socket. */
  throwOnUse = false
  buffered = 0
  private msgCb?: (data: string | Buffer | ArrayBuffer, isBinary: boolean) => void
  private closeCb?: () => void
  send(d: string | Uint8Array): void {
    if (this.throwOnUse) throw new Error('socket gone')
    this.sent.push(d)
  }
  close(code?: number, reason?: string): void {
    if (this.throwOnUse) throw new Error('socket gone')
    this.closed.push([code, reason])
  }
  onMessage(cb: (data: string | Buffer | ArrayBuffer, isBinary: boolean) => void): void { this.msgCb = cb }
  onClose(cb: () => void): void { this.closeCb = cb }
  bufferedAmount(): number { return this.buffered }
  emitMessage(data: string | Buffer | ArrayBuffer, isBinary: boolean): void { this.msgCb?.(data, isBinary) }
  emitClose(): void { this.closeCb?.() }
  /** Text frames, parsed. */
  controls(): unknown[] {
    return this.sent.filter((s): s is string => typeof s === 'string').map((s) => JSON.parse(s) as unknown)
  }
  /** Binary frames as latin1 text (one char per byte). */
  binaries(): string[] {
    return this.sent.filter((s) => typeof s !== 'string').map((s) => Buffer.from(s).toString('latin1'))
  }
}

/** One pane as the scripted tmux knows it. `vars` answers `display -p`
 *  formats by name. */
interface FakePane {
  vars: Record<string, string>
  history: string[]
  screen: string[]
  /** The saved normal screen while the alternate screen is on. */
  saved: string[]
}

function normalPane(): FakePane {
  return {
    vars: {
      pane_id: '%3', window_id: '@1', pane_width: '120', pane_height: '3',
      cursor_x: '2', cursor_y: '1', cursor_flag: '1', alternate_on: '0',
      alternate_saved_x: '0', alternate_saved_y: '0',
      scroll_region_upper: '0', scroll_region_lower: '2',
      keypad_cursor_flag: '0', keypad_flag: '0', insert_flag: '0', wrap_flag: '1', origin_flag: '0',
      mouse_standard_flag: '0', mouse_button_flag: '0', mouse_any_flag: '0', mouse_sgr_flag: '0', mouse_utf8_flag: '0',
      cursor_shape: 'default', cursor_blinking: '0', history_size: '2',
    },
    history: ['old-1', '\x1b[31mold-2'],
    screen: ['$ ls', '$ ', ''],
    saved: [],
  }
}

/**
 * A tmux control-mode client, scripted: it answers the commands the mirror
 * sends from one pane's state, records them, and lets a test emit
 * notifications. Replies arrive a microtask after the command, as they
 * would off a socket. `beforeReply` lets a test interleave notifications
 * with one command line's replies.
 */
class FakeTmux implements StreamChild {
  commands: string[] = []
  killed = false
  beforeReply?: (command: string) => string
  private dataCbs: Array<(chunk: Buffer | string) => void> = []
  private exitCbs: Array<() => void> = []

  constructor(public pane: FakePane) {}

  stdin = {
    write: (data: string): void => {
      for (const line of data.split('\n').filter(Boolean)) {
        // `;` separates commands outside double quotes.
        const commands = line.match(/(?:[^;"]|"(?:\\.|[^"\\])*")+/g)?.map((c) => c.trim()) ?? []
        let out = ''
        for (const cmd of commands) {
          this.commands.push(cmd)
          out += this.beforeReply?.(cmd) ?? ''
          out += `%begin 1 1 1\n${this.answer(cmd)}%end 1 1 1\n`
        }
        queueMicrotask(() => this.emit(out))
      }
    },
  }
  stdout = { on: (_e: 'data', cb: (chunk: Buffer | string) => void): void => {
    this.dataCbs.push(cb)
    // The attach's own reply block.
    queueMicrotask(() => this.emit('%begin 1 0 0\n%end 1 0 0\n%session-changed $0 yaac\n'))
  } }
  stderr = { on: (): void => {} }
  on(event: 'exit' | 'error', cb: (...args: unknown[]) => void): void {
    if (event === 'exit') this.exitCbs.push(cb)
  }
  kill(): boolean {
    this.killed = true
    return true
  }

  emit(text: string): void {
    for (const cb of this.dataCbs) cb(Buffer.from(text, 'latin1'))
  }
  /** `%output` with tmux's octal escaping of control bytes and `\`. */
  output(paneId: string, raw: string): void {
    this.emit(`%output ${paneId} ${outputLine(raw)}\n`)
  }
  exit(): void {
    for (const cb of this.exitCbs) cb()
  }

  private answer(cmd: string): string {
    const lines = (ls: string[]): string => ls.map((l) => `${l}\n`).join('')
    const display = /^display -p -t (\S+) '(.*)'$/.exec(cmd)
    if (display) {
      const target = display[1].replace(/'/g, '')
      const p = this.pane
      if (![p.vars.pane_id, p.vars.window_id, 'yaac:^'].includes(target)) return 'no such pane\n'
      return `${display[2].replace(/#\{(\w+)\}/g, (_, name: string) => p.vars[name] ?? '')}\n`
    }
    if (cmd.startsWith('capture-pane')) {
      if (cmd.includes(' -a ')) return lines(this.pane.saved)
      if (cmd.includes('-E -1 ')) return lines(this.pane.history)
      if (cmd.includes('-E - ')) return lines([...this.pane.history, ...this.pane.screen])
      return lines(this.pane.screen)
    }
    return ''
  }
}

function outputLine(raw: string): string {
  return raw.replace(/[\x00-\x1f\\]/g, (c) => `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`)
}

const execCalls: string[] = []
let execImpl: (cmd: string) => Promise<{ stdout: string; stderr: string }>
let tmuxes: FakeTmux[] = []
let nextPane: () => FakePane

beforeEach(() => {
  execCalls.length = 0
  execImpl = () => Promise.resolve({ stdout: '', stderr: '' })
  execMock.mockImplementation((_job, cmd) => {
    execCalls.push(cmd)
    return execImpl(cmd)
  })
  dialPtyMock.mockImplementation(() => new FakePty())
  tmuxes = []
  nextPane = normalPane
  dialCtrlMock.mockClear()
  dialCtrlMock.mockImplementation(() => {
    const t = new FakeTmux(nextPane())
    tmuxes.push(t)
    return t
  })
  installFakeWorkspaceDriver({ exec: execMock, dialPty: dialPtyMock, dialCtrl: dialCtrlMock })
})

/** Let replies and the attach's awaits run (microtasks only, so fake timers
 *  work). */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 100; i++) await Promise.resolve()
}

interface Attached {
  pty: FakePty
  sock: FakeSock
  jobName: string
  argv: string[]
  size: { cols?: number; rows?: number }
  /** The in-pod command. */
  cmd: string
  /** The per-client view session this attach created. */
  view: string
}

/** Attach a CLI target, which runs over a PTY stream. */
function attach(
  jobName: string,
  query: { target?: string; cols?: string; rows?: string },
): Attached {
  const sock = new FakeSock()
  attachPty(jobName, sock, query)
  const [dialedJob, argv, size] = dialPtyMock.mock.calls[dialPtyMock.mock.calls.length - 1]
  const pty = dialPtyMock.mock.results[dialPtyMock.mock.results.length - 1].value as unknown as FakePty
  const cmd = argv[2] ?? ''
  return {
    pty, sock, jobName: dialedJob, argv, size, cmd,
    view: /-s (view-[0-9a-f]{8}) /.exec(cmd)?.[1] ?? '',
  }
}

/** Attach a webapp target, which the pane mirror serves. */
async function view(
  jobName: string,
  query: { target?: string; cols?: string; rows?: string },
): Promise<FakeSock> {
  const sock = new FakeSock()
  attachPty(jobName, sock, query)
  await flush()
  return sock
}

describe('attachPty', () => {
  it('seeds a webapp viewer from tmux, then streams its pane\'s raw output', async () => {
    const sock = await view(job(20), { target: 'agent', cols: '120', rows: '3' })
    const tmux = tmuxes[0]
    // One read-write control client, attached to the session.
    expect(dialCtrlMock).toHaveBeenCalledWith(job(20), [
      'tmux', '-S', '/tmp/yaac-tmux/server', '-C', 'attach-session', '-t', 'yaac',
    ])
    expect(tmux.commands.slice(0, 5)).toEqual([
      // The agent is the lowest-index window.
      "display -p -t 'yaac:^' '#{pane_id} #{window_id}'",
      'set-option -w -t @1 window-size latest',
      // Sized before the snapshot is taken: this window, and the first
      // viewer's size as the default for windows nobody views (else 80x24).
      'refresh-client -C 120x3',
      'refresh-client -C @1:120x3',
      "display -p -t %3 '#{alternate_on} #{history_size}'",
    ])
    expect(tmux.commands[6]).toBe('capture-pane -p -e -J -S -5000 -E - -t %3')

    // The pane's size, then a snapshot: reset, the captured lines joined
    // with a bare CR-LF (a capture's colour carries across lines), the
    // cursor, and bracketed paste on.
    expect(sock.controls()).toEqual([{ type: 'size', cols: 120, rows: 3 }])
    expect(sock.binaries()).toEqual([
      '\x1bcold-1\r\n\x1b[31mold-2\r\n$ ls\r\n$ \r\n'
      + '\x1b[0m\x1b[2;3H\x1b[0 q\x1b[?2004h',
    ])

    // Live output arrives raw, unescaped.
    tmux.output('%3', 'hi\\there\r\n')
    expect(sock.binaries()[1]).toBe('hi\\there\r\n')
    // A pane nobody views is switched off, once.
    tmux.output('%9', 'noise')
    tmux.output('%9', 'more noise')
    await flush()
    expect(tmux.commands.filter((c) => c.includes('%9'))).toEqual(["refresh-client -A '%9:off'"])
    expect(sock.binaries()).toHaveLength(2)

    // A malformed or injected target falls back to the agent; a window
    // target names its window.
    const resolved = (): string | undefined => tmux.commands.filter((c) => c.endsWith("'#{pane_id} #{window_id}'")).at(-1)
    for (const target of [undefined, 'window:7', 'window:@x', "window:@1' \\; kill-server"]) {
      await view(job(20), { target })
      expect(resolved(), `target ${String(target)}`).toBe("display -p -t 'yaac:^' '#{pane_id} #{window_id}'")
    }
    await view(job(20), { target: 'window:@1' })
    expect(resolved()).toBe("display -p -t '@1' '#{pane_id} #{window_id}'")
    expect(dialCtrlMock).toHaveBeenCalledTimes(1)
  })

  it('drops output the snapshot already holds and replays what followed it', async () => {
    nextPane = normalPane
    const sock = new FakeSock()
    attachPty(job(21), sock, { target: 'agent' })
    await Promise.resolve()
    const tmux = tmuxes[0]
    // Output before the seed's last reply is in the capture, including
    // output while the pane is still being set up; output and a resize after
    // it are not.
    tmux.beforeReply = (cmd) => cmd.startsWith('capture-pane') || cmd.startsWith('set-option')
      ? `%output %3 ${outputLine('in-capture')}\n`
      : ''
    const lastReply = tmux.stdin.write
    tmux.stdin.write = (data: string): void => {
      lastReply(data)
      if (data.includes('capture-pane')) {
        queueMicrotask(() => queueMicrotask(() => {
          tmux.output('%3', 'after')
          tmux.emit('%layout-change @1 b25d,90x20,0,0,3 b25d,90x20,0,0,3 *\n')
        }))
      }
    }
    await flush()
    expect(sock.binaries()[0]).toMatch(/^\x1bc/)
    expect(sock.binaries().slice(1)).toEqual(['after'])
    expect(sock.controls()).toEqual([{ type: 'size', cols: 120, rows: 3 }, { type: 'size', cols: 90, rows: 20 }])
    // The size frame follows the output it applies after.
    expect(sock.sent.map((s) => typeof s === 'string' ? 'size' : 'bytes')).toEqual(['size', 'bytes', 'bytes', 'size'])
  })

  it('restores the alternate screen, mouse tracking and cursor', async () => {
    nextPane = (): FakePane => {
      const p = normalPane()
      Object.assign(p.vars, {
        alternate_on: '1', alternate_saved_x: '4', alternate_saved_y: '2',
        cursor_x: '0', cursor_y: '0', cursor_flag: '0',
        mouse_any_flag: '1', mouse_sgr_flag: '1', keypad_cursor_flag: '1',
        cursor_shape: 'bar', cursor_blinking: '1',
        scroll_region_upper: '1', scroll_region_lower: '2',
      })
      p.saved = ['$ claude', '', '']
      p.screen = ['ALT', 'TUI', '>']
      return p
    }
    const sock = await view(job(22), { target: 'agent' })
    // On the alternate screen: the history, the saved normal screen and the
    // alternate screen, captured separately.
    expect(tmuxes[0].commands.slice(2)).toEqual([
      "display -p -t %3 '#{alternate_on} #{history_size}'",
      expect.stringMatching(/^display -p -t %3 '#\{pane_width\} /),
      'capture-pane -p -e -J -S -5000 -E -1 -t %3',
      'capture-pane -p -e -a -q -t %3',
      'capture-pane -p -e -t %3',
    ])
    expect(sock.binaries()).toEqual([
      // History and the saved normal screen, then the saved cursor and the
      // switch, then the alternate screen.
      '\x1bcold-1\r\n\x1b[31mold-2\r\n$ claude\r\n\r\n'
      + '\x1b[3;5H\x1b[?1049h\x1b[HALT\r\nTUI\r\n>'
      + '\x1b[0m\x1b[2;3r\x1b[1;1H\x1b[?1h\x1b[?1003h\x1b[?1006h\x1b[?25l\x1b[5 q\x1b[?2004h',
    ])
  })

  it('sends input to the pane through tmux, and sizes it after the latest client', async () => {
    const a = await view(job(23), { target: 'agent', cols: '100', rows: '30' })
    const b = await view(job(23), { target: 'window:@1', cols: '80', rows: '20' })
    const tmux = tmuxes[0]
    const sent = (): string[] => tmux.commands.filter((c) => /^(send-keys|set-buffer|paste-buffer|refresh-client -C)/.test(c))
    tmux.commands.length = 0

    // Keystrokes, chunked so command lines stay short. Typing in a viewer
    // that is not the latest re-applies its size, as typing does for a
    // tmux client.
    a.emitMessage(Buffer.from('ls\r'), true)
    a.emitMessage(new TextEncoder().encode('é').buffer, true)
    a.emitMessage(Buffer.alloc(600, 'x'), true)
    await flush()
    expect(sent()).toEqual([
      'refresh-client -C @1:100x30',
      'send-keys -t %3 -H 6c 73 0d',
      'send-keys -t %3 -H c3 a9',
      `send-keys -t %3 -H ${Array(512).fill('78').join(' ')}`,
      `send-keys -t %3 -H ${Array(88).fill('78').join(' ')}`,
    ])

    // A bracketed paste goes through a tmux buffer; `-p` re-brackets only
    // if the app asked. Text around it stays keystrokes.
    tmux.commands.length = 0
    // `$` and `~` are escaped: tmux expands both, `~` even in quotes.
    a.emitMessage(Buffer.from('k\x1b[200~~/a"$b\\ ; c\ré\x1b[201~z'), true)
    await flush()
    expect(sent()).toEqual([
      'send-keys -t %3 -H 6b',
      'set-buffer -b yaac-paste -- "\\176/a\\"\\$b\\\\ ; c\\015\\303\\251"',
      'paste-buffer -p -r -d -b yaac-paste -t %3',
      'send-keys -t %3 -H 7a',
    ])

    // A resize makes that client the latest; the other's typing takes it
    // back.
    tmux.commands.length = 0
    b.emitMessage('{"type":"resize","cols":70,"rows":25}', false)
    b.emitMessage(Buffer.from('q'), true)
    a.emitMessage(Buffer.from('w'), true)
    await flush()
    expect(sent()).toEqual([
      'refresh-client -C @1:70x25',
      'send-keys -t %3 -H 71',
      'refresh-client -C @1:100x30',
      'send-keys -t %3 -H 77',
    ])

    // When the viewer sizing a window leaves, another viewer of it takes
    // over; when the last one leaves, the window goes back to tmux's other
    // clients (a CLI attach), since this client's size would override theirs.
    tmux.commands.length = 0
    const c = await view(job(23), { target: 'agent', cols: '60', rows: '20' })
    tmux.commands.length = 0
    c.emitClose()
    b.emitClose()
    await flush()
    // The latest remaining viewer each time.
    expect(sent()).toEqual(['refresh-client -C @1:70x25', 'refresh-client -C @1:100x30'])
    tmux.commands.length = 0
    const pinger = a
    // Pings get timed pongs; a signal has no process to reach; junk is
    // ignored.
    tmux.commands.length = 0
    pinger.emitMessage('{"type":"ping","t":1234.5}', false)
    pinger.emitMessage('{"type":"ping"}', false)
    for (const junk of ['{"type":"signal","name":"SIGINT"}', 'not json', '{"type":"resize"}']) pinger.emitMessage(junk, false)
    await flush()
    expect(pinger.sent.slice(-2)).toEqual(['{"type":"pong","t":1234.5}', '{"type":"pong"}'])
    expect(tmux.commands).toEqual([])
    a.emitClose()
    await flush()
    expect(tmux.commands).toEqual(["refresh-client -C '@1:'"])
  })

  it('follows the pane: resizes, closes with it, and re-seeds a client that fell behind', async () => {
    vi.useFakeTimers()
    try {
      const a = await view(job(24), { target: 'agent' })
      const tmux = tmuxes[0]
      tmux.emit('%layout-change @1 c0de,100x40,0,0,3 c0de,100x40,0,0,3 *\n')
      // A change elsewhere is not this pane's.
      tmux.emit('%layout-change @2 c0de,10x4,0,0,8 c0de,10x4,0,0,8 *\n')
      expect(a.controls().at(-1)).toEqual({ type: 'size', cols: 100, rows: 40 })
      expect(a.controls()).toHaveLength(2)

      // A client whose send buffer is past the high-water mark gets no more
      // output; once it drains it gets one fresh snapshot instead.
      a.buffered = FLOOD_HIGH_WATER + 1
      tmux.output('%3', 'flood')
      vi.advanceTimersByTime(BATCH_MS)
      expect(a.binaries()).toHaveLength(1)
      a.buffered = 0
      vi.advanceTimersByTime(250)
      await flush()
      expect(a.binaries()).toHaveLength(2)
      expect(a.binaries()[1]).toMatch(/^\x1bcold-1/)
      tmux.output('%3', 'live again')
      expect(a.binaries()[2]).toBe('live again')

      // A split pane that closes ends its viewer; so does a closed window.
      const b = await view(job(24), { target: 'window:@1' })
      tmux.emit('%layout-change @1 c0de,100x40,0,0,4 c0de,100x40,0,0,4 *\n')
      expect(a.closed).toEqual([[1000, 'pane closed']])
      expect(b.closed).toEqual([[1000, 'pane closed']])
      const c = await view(job(24), { target: 'agent' })
      tmux.emit('%window-close @1\n')
      expect(c.closed).toEqual([[1000, 'window closed']])
    } finally {
      vi.useRealTimers()
    }
  })

  it('shares one control client per workspace and ends it after the last viewer', async () => {
    vi.useFakeTimers()
    try {
      const a = await view(job(25), { target: 'agent' })
      const b = await view(job(25), { target: 'agent' })
      expect(dialCtrlMock).toHaveBeenCalledTimes(1)
      a.emitClose()
      b.emitClose()
      vi.advanceTimersByTime(MIRROR_IDLE_MS - 1)
      expect(tmuxes[0].killed).toBe(false)
      // A viewer within the idle window keeps it.
      const c = await view(job(25), { target: 'agent' })
      c.emitClose()
      vi.advanceTimersByTime(MIRROR_IDLE_MS)
      expect(tmuxes[0].killed).toBe(true)
      await view(job(25), { target: 'agent' })
      expect(dialCtrlMock).toHaveBeenCalledTimes(2)

      // The stream ending (tmux gone, a dropped relay) closes open viewers
      // so they reconnect to a fresh client; one that cannot resolve its
      // pane is refused.
      const d = await view(job(26), { target: 'agent' })
      tmuxes[2].exit()
      expect(d.closed).toEqual([[1011, 'stream closed']])
      nextPane = (): FakePane => ({ ...normalPane(), vars: { ...normalPane().vars, pane_id: '' } })
      const e = await view(job(27), { target: 'agent' })
      expect(e.closed[0]?.[0]).toBe(1011)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the tmux chrome and the group\'s own window for the CLI native attach', async () => {
    const a = attach(job(4), { target: 'native', cols: '150', rows: '40' })
    await flush()
    expect(a.size).toEqual({ cols: 150, rows: 40 })
    expect(a.cmd).toBe(
      `${TMUX} has-session -t =yaac 2>/dev/null`
      + ` && ${TMUX} new-session -d -t yaac -s ${a.view} -x 150 -y 40`
      + ` && exec ${TMUX} attach-session -t ${a.view}`
      + ' \\; set-option destroy-unattached on',
    )

    // An unusable grid defaults to 80x24; out-of-range sizes are dropped per
    // axis and fractions truncate.
    const bad = attach(job(2), { target: 'native', cols: '0', rows: 'abc' })
    expect(bad.size).toEqual({ cols: undefined, rows: undefined })
    expect(bad.cmd).toContain('-x 80 -y 24')
    const mixed = attach(job(2), { target: 'native', cols: '5000', rows: '40.9' })
    expect(mixed.size).toEqual({ cols: undefined, rows: 40 })
    expect(mixed.cmd).toContain('-x 80 -y 40')
  })

  it('gives the shell target a raw login shell with no view session to manage', async () => {
    const a = attach(job(5), { target: 'shell', cols: '100', rows: '30' })
    await flush()
    expect(a.argv).toEqual(['sh', '-c', 'exec "${SHELL:-sh}" -l'])
    expect(a.size).toEqual({ cols: 100, rows: 30 })
    // No tmux commands at all.
    a.sock.emitMessage('{"type":"resize","cols":120,"rows":40}', false)
    expect(a.pty.resized).toEqual([[120, 40]])
    a.sock.emitClose()
    await flush()
    expect(execCalls).toEqual([])
  })

  it('reaps ghost views on attach, sparing every view a live connection owns', async () => {
    let listing: string[] = []
    execImpl = (cmd) => Promise.resolve({
      stdout: cmd === LIST_SESSIONS ? `${listing.join('\n')}\n` : '',
      stderr: '',
    })

    // Stranded views are killed; only exact view-name shapes qualify.
    listing = ['yaac', 'view-deadbeef', 'view-nothex!', 'view-badc0ffee', 'my-session']
    const a = attach(job(6), { target: 'native' })
    await flush()
    expect(execCalls).toEqual([LIST_SESSIONS, `${TMUX} kill-session -t view-deadbeef`])

    // A second client: the first one's live view is left alone.
    execCalls.length = 0
    listing = ['yaac', a.view, 'view-aabbccdd']
    const b = attach(job(6), { target: 'native' })
    await flush()
    expect(execCalls).toEqual([LIST_SESSIONS, `${TMUX} kill-session -t view-aabbccdd`])

    // Nothing left to kill, so only the listing runs.
    execCalls.length = 0
    listing = ['yaac', a.view, b.view]
    attach(job(6), { target: 'native' })
    await flush()
    expect(execCalls).toEqual([LIST_SESSIONS])

    // After both close, the next attach kills both views in one command.
    a.sock.emitClose()
    b.sock.emitClose()
    await flush()
    execCalls.length = 0
    listing = ['yaac', a.view, b.view]
    attach(job(6), { target: 'native' })
    await flush()
    expect(execCalls).toEqual([
      LIST_SESSIONS,
      `${TMUX} kill-session -t ${a.view} \\; kill-session -t ${b.view}`,
    ])
  })

  it('keeps a view live when the last connection detaches after it registered', async () => {
    vi.useFakeTimers()
    try {
      let listing: string[] = []
      execImpl = (cmd) => Promise.resolve({
        stdout: cmd === LIST_SESSIONS ? `${listing.join('\n')}\n` : '',
        stderr: '',
      })

      const gone = attach(job(13), { target: 'native' })
      await flush()
      gone.sock.emitClose()
      await flush()

      // A new connection arrives within the grace window, as on a reattach.
      const live = attach(job(13), { target: 'native' })
      await flush()

      // The old connection's delayed detach must not remove the new entry.
      vi.advanceTimersByTime(DETACH_GRACE_MS)
      await flush()

      // Otherwise the next sweep would kill the live view, and the two
      // clients would keep killing each other's views.
      execCalls.length = 0
      listing = ['yaac', live.view, 'view-aabbccdd']
      attach(job(13), { target: 'native' })
      await flush()
      expect(execCalls).toEqual([LIST_SESSIONS, `${TMUX} kill-session -t view-aabbccdd`])
    } finally {
      vi.useRealTimers()
    }
  })

  it('attaches anyway when the sweep cannot list or cannot kill', async () => {
    execImpl = () => Promise.reject(new Error('no pod'))
    const a = attach(job(7), { target: 'native' })
    await flush()
    expect(a.cmd).toContain('attach-session')

    // The listing works but the kill fails (view or pod already gone).
    execCalls.length = 0
    execImpl = (cmd) => cmd === LIST_SESSIONS
      ? Promise.resolve({ stdout: 'view-deadbeef\n', stderr: '' })
      : Promise.reject(new Error('no such session'))
    const b = attach(job(7), { target: 'native' })
    await flush()
    expect(execCalls).toEqual([LIST_SESSIONS, `${TMUX} kill-session -t view-deadbeef`])
    expect(b.cmd).toContain('attach-session')
  })

  it('carries the PTY wire protocol both ways and ignores unrecognized frames', async () => {
    const a = attach(job(8), { target: 'native' })
    await flush()

    a.pty.emitData('hello')
    expect(Buffer.from(a.sock.sent[0] as Uint8Array).toString('utf8')).toBe('hello')

    // Binary input is keystrokes, as a Buffer or ArrayBuffer.
    a.sock.emitMessage(Buffer.from('ls\r', 'utf8'), true)
    a.sock.emitMessage(new TextEncoder().encode('q').buffer, true)
    expect(a.pty.written).toEqual(['ls\r', 'q'])

    // A resize changes only the tty; tmux resizes the window itself.
    execCalls.length = 0
    a.sock.emitMessage('{"type":"resize","cols":100,"rows":30}', false)
    expect(a.pty.resized).toEqual([[100, 30]])
    expect(execCalls).toEqual([])

    a.sock.emitMessage('{"type":"signal","name":"SIGINT"}', false)
    expect(a.pty.killed).toEqual(['SIGINT'])

    a.sock.emitMessage('{"type":"ping"}', false)
    expect(a.sock.sent).toContain('{"type":"pong"}')

    // The pong echoes the ping's timestamp so the client can measure latency.
    a.sock.emitMessage('{"type":"ping","t":1234.5}', false)
    expect(a.sock.sent).toContain('{"type":"pong","t":1234.5}')
    // A non-numeric stamp gets a bare pong.
    a.sock.emitMessage('{"type":"ping","t":"soon"}', false)
    a.sock.emitMessage('{"type":"ping","t":null}', false)
    expect(a.sock.sent.filter((s) => s === '{"type":"pong"}')).toHaveLength(3)

    // Malformed or unknown frames are ignored.
    const before = { sent: a.sock.sent.length, killed: a.pty.killed.length }
    for (const junk of [
      'not json', '42', 'null', '{"type":"nope"}', '{"type":"resize"}', '{"type":"signal"}',
    ]) a.sock.emitMessage(junk, false)
    expect(a.sock.sent).toHaveLength(before.sent)
    expect(a.pty.killed).toHaveLength(before.killed)
    expect(a.pty.resized).toEqual([[100, 30]])

    // PTY exit closes the socket.
    a.pty.emitExit(3)
    expect(a.sock.closed).toEqual([[1000, 'pty exited (3)']])
  })

  it('coalesces an output burst into one frame per window, flushing before the close', async () => {
    // Fake timers first: the batcher captures the clock when created.
    vi.useFakeTimers()
    try {
      const a = attach(job(14), { target: 'native' })
      await flush()
      const frames = (): string[] =>
        a.sock.sent.map((s) => Buffer.from(s as Uint8Array).toString('utf8'))

      // The first write after a quiet period is sent at once.
      a.pty.emitData('a')
      expect(frames()).toEqual(['a'])

      // Later writes in the window are batched into one frame (see batcher.ts).
      a.pty.emitData('b')
      a.pty.emitData('c')
      expect(a.sock.sent).toHaveLength(1)
      vi.advanceTimersByTime(BATCH_MS)
      expect(frames()).toEqual(['a', 'bc'])

      // Pending output is sent before the close.
      a.pty.emitData('bye')
      expect(a.sock.sent).toHaveLength(2)
      a.pty.emitExit(0)
      expect(frames()).toEqual(['a', 'bc', 'bye'])
      expect(a.sock.closed).toEqual([[1000, 'pty exited (0)']])

      // Output after the close is dropped.
      a.pty.emitData('after')
      a.sock.emitClose()
      vi.advanceTimersByTime(BATCH_MS * 4)
      expect(frames()).toEqual(['a', 'bc', 'bye'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('survives a socket that vanished between frames', async () => {
    const a = attach(job(9), { target: 'native' })
    await flush()
    a.sock.throwOnUse = true
    // Must not throw, since the close handler is what kills the PTY.
    expect(() => a.pty.emitData('hello')).not.toThrow()
    expect(() => a.pty.emitExit(1)).not.toThrow()
  })

  it('closing kills the view session, tolerating one already gone', async () => {
    const a = attach(job(11), { target: 'native' })
    await flush()
    execCalls.length = 0
    // "no such session" (closed before attaching) is fine.
    execImpl = () => Promise.reject(new Error('no such session'))
    a.sock.emitClose()
    await flush()
    expect(execCalls).toEqual([`${TMUX} kill-session -t ${a.view}`])
  })

  it('re-detaches at the grace deadline, then force-kills the PTY', async () => {
    vi.useFakeTimers()
    try {
      const a = attach(job(12), { target: 'native' })
      await flush()
      execCalls.length = 0

      a.sock.emitClose()
      await flush()
      // First an in-pod kill-session; killing only the host side could leave
      // the tmux client attached.
      expect(execCalls).toEqual([`${TMUX} kill-session -t ${a.view}`])
      expect(a.pty.written).toEqual([])
      expect(a.pty.killed).toEqual([])

      vi.advanceTimersByTime(DETACH_GRACE_MS)
      await flush()
      // A second kill-session covers a close before the attach finished; the
      // host-side kill is the last resort.
      expect(execCalls).toHaveLength(2)
      expect(a.pty.killed).toEqual([undefined])
    } finally {
      vi.useRealTimers()
    }
  })
})
