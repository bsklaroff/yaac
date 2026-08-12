/**
 * The PTY attach entry point — `attachPty`.
 *
 * Nothing under features/terminals is mocked here: the query validation, the
 * tmux attach argv, the per-client view lifecycle (register, ghost sweep,
 * window resize, kill-session) and the wire protocol all run for real, and
 * the fakes start at the relay — `dialPtyStream` for the in-pod PTY and
 * `podExec` for every tmux command. The internals are covered by the
 * targets, sizes and frames these tests drive rather than by tests of their
 * own.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type * as relayModule from '#runtime/k8s/substrate/stream-relay'
import { dialPtyStream, podExec } from '#runtime/k8s/substrate/stream-relay'
import { attachPty, type SocketLike } from '#runtime/terminals'
import { DETACH_GRACE_MS } from '#runtime/terminals/pty-bridge'

vi.mock('#runtime/k8s/substrate/stream-relay', async (importOriginal) => ({
  ...await importOriginal<typeof relayModule>(),
  podExec: vi.fn(),
  dialPtyStream: vi.fn(),
}))

const TMUX = 'tmux -S /tmp/yaac-tmux/server'
const LIST_SESSIONS = `${TMUX} list-sessions -F '#{session_name}'`

/** The live-view registry is server-wide, so each test that must not see
 *  another's views uses its own session Job (the relay recovers the session
 *  id from the name's 36-char UUID tail). */
const sid = (n: number): string => `0f9b2c4d-1111-2222-3333-4444555566${String(n).padStart(2, '0')}`
const job = (n: number): string => `yaac-demo-${sid(n)}`

/** Every webapp attach creates its per-client grouped view session detached,
 *  with the chrome-less options applied before any client is attached:
 *  `status off`, `prefix None`, and per-view `window-size manual` (which, with
 *  the resize-window in the attach sequence, pins the shared window to this
 *  client — set per view, never globally, since global manual segfaults tmux
 *  3.4). */
const VIEW_CREATE = (view: string, cols: number, rows: number): string =>
  `${TMUX} new-session -d -t yaac -s ${view} -x ${cols} -y ${rows}`
  + ` \\; set-option -t ${view} status off`
  + ` \\; set-option -t ${view} prefix None`
  + ` \\; set-option -t ${view} window-size manual`

class FakePty implements relayModule.StreamPty {
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
  /** Simulate a client that vanished between frames: `ws` throws on a send
   *  to a socket that is already gone. */
  throwOnUse = false
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
  emitMessage(data: string | Buffer | ArrayBuffer, isBinary: boolean): void { this.msgCb?.(data, isBinary) }
  emitClose(): void { this.closeCb?.() }
}

const execCalls: string[] = []
let execImpl: (cmd: string) => Promise<{ stdout: string; stderr: string }>

beforeEach(() => {
  execCalls.length = 0
  execImpl = () => Promise.resolve({ stdout: '', stderr: '' })
  vi.mocked(podExec).mockImplementation((_job, cmd) => {
    execCalls.push(cmd)
    return execImpl(cmd)
  })
  vi.mocked(dialPtyStream).mockImplementation(() => new FakePty())
})

/** Drain the fire-and-forget ghost sweep (microtasks only, so this works
 *  under fake timers too). */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

interface Attached {
  pty: FakePty
  sock: FakeSock
  worktreeId: string
  argv: string[]
  size: { cols?: number; rows?: number }
  /** The in-pod command line, for non-'shell' targets. */
  cmd: string
  /** The per-client view session this attach minted. */
  view: string
}

function attach(
  jobName: string,
  query: { target?: string; cols?: string; rows?: string } = {},
): Attached {
  const sock = new FakeSock()
  attachPty(jobName, sock, query)
  const dial = vi.mocked(dialPtyStream)
  const [worktreeId, argv, size] = dial.mock.calls[dial.mock.calls.length - 1]
  const pty = dial.mock.results[dial.mock.results.length - 1].value as unknown as FakePty
  const cmd = argv[2] ?? ''
  return { pty, sock, worktreeId, argv, size, cmd, view: /-s (view-[0-9a-f]{8}) /.exec(cmd)?.[1] ?? '' }
}

describe('attachPty', () => {
  it('attaches the agent window through a fresh, client-sized view session', async () => {
    const a = attach(job(1), { target: 'agent', cols: '150', rows: '40' })
    await flush()

    // The relay dials the pod by the session id in the Job name, and the PTY
    // is spawned at the browser's grid so no cold-start reflow is needed.
    expect(a.worktreeId).toBe(sid(1))
    expect(a.size).toEqual({ cols: 150, rows: 40 })
    expect(a.argv.slice(0, 2)).toEqual(['sh', '-c'])
    expect(a.view).toMatch(/^view-[0-9a-f]{8}$/)
    expect(a.cmd).toBe(
      // The has-session guard is load-bearing: without it `new-session -t
      // yaac` mints a stale group whose bare-shell window poisons every
      // later view, instead of failing so the client retries.
      `${TMUX} has-session -t =yaac 2>/dev/null`
      + ` && ${VIEW_CREATE(a.view, 150, 40)}`
      + ` && exec ${TMUX} attach-session -t ${a.view}`
      // Agent = the yaac session's lowest-index window.
      + ` \\; select-window -t '${a.view}:^'`
      + ` \\; resize-window -t ${a.view} -x 150 -y 40`
      // Set only after the attach, so nothing can reap the view in the
      // created-but-not-yet-attached gap.
      + ' \\; set-option destroy-unattached on',
    )
    // Per view, never globally — global manual segfaults container tmux 3.4.
    expect(a.cmd).not.toContain('set-option -g window-size')

    // Each connection gets its own view session.
    expect(attach(job(1), { target: 'agent' }).view).not.toBe(a.view)
  })

  it('pins a window target to that window, defaulting an unusable grid to 80x24', async () => {
    const bad = attach(job(2), { target: 'window:@3', cols: '0', rows: 'abc' })
    await flush()
    expect(bad.size).toEqual({ cols: undefined, rows: undefined })
    expect(bad.cmd).toContain(VIEW_CREATE(bad.view, 80, 24))
    expect(bad.cmd).toContain(`select-window -t '@3'`)
    expect(bad.cmd).toContain(`resize-window -t ${bad.view} -x 80 -y 24`)

    // Absurd widths are dropped per-axis; fractional rows truncate.
    const mixed = attach(job(2), { target: 'window:@3', cols: '5000', rows: '40.9' })
    await flush()
    expect(mixed.size).toEqual({ cols: undefined, rows: 40 })
    expect(mixed.cmd).toContain('-x 80 -y 40')
  })

  it('falls back to the agent for a missing, malformed or injected target', async () => {
    for (const target of [
      undefined, 'window:7', 'window:@x', 'shell:shell', "window:@1' \\; kill-server",
    ]) {
      const a = attach(job(3), { target })
      await flush()
      expect(a.cmd, `target ${String(target)}`).toContain(`select-window -t '${a.view}:^'`)
    }
  })

  it('keeps the tmux chrome and default sizing for the CLI native attach', async () => {
    const a = attach(job(4), { target: 'native', cols: '150', rows: '40' })
    await flush()
    expect(a.cmd).toBe(
      `${TMUX} has-session -t =yaac 2>/dev/null`
      + ` && ${TMUX} new-session -d -t yaac -s ${a.view} -x 150 -y 40`
      + ` && exec ${TMUX} attach-session -t ${a.view}`
      + ' \\; set-option destroy-unattached on',
    )
    // Native has a status bar and switches windows live, so it wants tmux's
    // standard client-driven sizing — the webapp-only pin would fight it.
    expect(a.cmd).not.toContain('window-size manual')

    // …and a resize therefore only moves the tty; nothing drives
    // resize-window for it.
    execCalls.length = 0
    a.sock.emitMessage('{"type":"resize","cols":100,"rows":30}', false)
    expect(a.pty.resized).toEqual([[100, 30]])
    expect(execCalls).toEqual([])
  })

  it('gives the shell target a raw zsh with no view session to manage', async () => {
    const a = attach(job(5), { target: 'shell', cols: '100', rows: '30' })
    await flush()
    expect(a.argv).toEqual(['zsh'])
    expect(a.size).toEqual({ cols: 100, rows: 30 })
    // No tmux at all: nothing to sweep, resize or kill-session.
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

    // A stranded view (crashed server, sleep-dropped exec) is a corpse; the
    // name-shape check keeps everything else out of the kill list, however
    // view-ish it looks.
    listing = ['yaac', 'view-deadbeef', 'view-nothex!', 'view-badc0ffee', 'my-session']
    const a = attach(job(6), { target: 'agent' })
    await flush()
    expect(execCalls).toEqual([LIST_SESSIONS, `${TMUX} kill-session -t view-deadbeef`])

    // A second tab on the same session: the first tab's view is live, so the
    // sweep must walk past it and take only the corpse.
    execCalls.length = 0
    listing = ['yaac', a.view, 'view-aabbccdd']
    const b = attach(job(6), { target: 'agent' })
    await flush()
    expect(execCalls).toEqual([LIST_SESSIONS, `${TMUX} kill-session -t view-aabbccdd`])

    // Nothing unowned left: the listing is the only command that goes out.
    execCalls.length = 0
    listing = ['yaac', a.view, b.view]
    attach(job(6), { target: 'agent' })
    await flush()
    expect(execCalls).toEqual([LIST_SESSIONS])

    // Once both connections close, their views become corpses the next
    // attach reaps together, in one tmux invocation.
    a.sock.emitClose()
    b.sock.emitClose()
    await flush()
    execCalls.length = 0
    listing = ['yaac', a.view, b.view]
    attach(job(6), { target: 'agent' })
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

      // The lone connection on this Job closes, emptying the registry entry.
      const gone = attach(job(13), { target: 'agent' })
      await flush()
      gone.sock.emitClose()
      await flush()

      // A new connection registers inside the closing one's grace window —
      // the shape of a page reload, or a second window opening as the first
      // one goes away.
      const live = attach(job(13), { target: 'agent' })
      await flush()

      // The closing connection's second detach must not evict the entry the
      // new connection just installed.
      vi.advanceTimersByTime(DETACH_GRACE_MS)
      await flush()

      // So the next attach's sweep still sees that view as owned. If the
      // registry were wiped, this would kill a healthy attached client — its
      // PTY exits, the webapp reconnects, and its own close wipes the entry
      // again, leaving the two clients reaping each other indefinitely.
      execCalls.length = 0
      listing = ['yaac', live.view, 'view-aabbccdd']
      attach(job(13), { target: 'agent' })
      await flush()
      expect(execCalls).toEqual([LIST_SESSIONS, `${TMUX} kill-session -t view-aabbccdd`])
    } finally {
      vi.useRealTimers()
    }
  })

  it('attaches anyway when the sweep cannot list or cannot kill', async () => {
    execImpl = () => Promise.reject(new Error('no pod'))
    const a = attach(job(7), { target: 'agent' })
    await flush()
    expect(a.cmd).toContain('attach-session')

    // Listing works, the kill races away (view self-destroyed, pod dying).
    execCalls.length = 0
    execImpl = (cmd) => cmd === LIST_SESSIONS
      ? Promise.resolve({ stdout: 'view-deadbeef\n', stderr: '' })
      : Promise.reject(new Error('no such session'))
    const b = attach(job(7), { target: 'agent' })
    await flush()
    expect(execCalls).toEqual([LIST_SESSIONS, `${TMUX} kill-session -t view-deadbeef`])
    expect(b.cmd).toContain('attach-session')
  })

  it('carries the wire protocol both ways and ignores unrecognized frames', async () => {
    const a = attach(job(8), { target: 'agent' })
    await flush()

    a.pty.emitData('hello')
    expect(Buffer.from(a.sock.sent[0] as Uint8Array).toString('utf8')).toBe('hello')

    // Binary in is keystrokes, as a Buffer or a bare ArrayBuffer.
    a.sock.emitMessage(Buffer.from('ls\r', 'utf8'), true)
    a.sock.emitMessage(new TextEncoder().encode('q').buffer, true)
    expect(a.pty.written).toEqual(['ls\r', 'q'])

    a.sock.emitMessage('{"type":"signal","name":"SIGINT"}', false)
    expect(a.pty.killed).toEqual(['SIGINT'])

    a.sock.emitMessage('{"type":"ping"}', false)
    expect(a.sock.sent).toContain('{"type":"pong"}')

    // Junk, non-objects, unknown types and half-filled frames are all no-ops.
    const before = { sent: a.sock.sent.length, killed: a.pty.killed.length }
    for (const junk of [
      'not json', '42', 'null', '{"type":"nope"}', '{"type":"resize"}', '{"type":"signal"}',
    ]) a.sock.emitMessage(junk, false)
    expect(a.sock.sent).toHaveLength(before.sent)
    expect(a.pty.killed).toHaveLength(before.killed)
    expect(a.pty.resized).toEqual([])

    // A PTY that exits takes the socket with it.
    a.pty.emitExit(3)
    expect(a.sock.closed).toEqual([[1000, 'pty exited (3)']])
  })

  it('survives a socket that vanished between frames', async () => {
    const a = attach(job(9), { target: 'agent' })
    await flush()
    a.sock.throwOnUse = true
    // Neither path may throw out of the relay's callbacks — the close
    // handler is what kills the PTY.
    expect(() => a.pty.emitData('hello')).not.toThrow()
    expect(() => a.pty.emitExit(1)).not.toThrow()
  })

  it('drives the view window on resize, serializing execs so the newest size wins', async () => {
    const a = attach(job(10), { target: 'agent' })
    await flush()
    execCalls.length = 0

    let release!: () => void
    const gate = new Promise<{ stdout: string; stderr: string }>((r) => {
      release = () => r({ stdout: '', stderr: '' })
    })
    execImpl = () => execCalls.length === 1 ? gate : Promise.resolve({ stdout: '', stderr: '' })

    const resize = (cols: number, rows: number): string => {
      a.sock.emitMessage(`{"type":"resize","cols":${cols},"rows":${rows}}`, false)
      return `${TMUX} resize-window -t ${a.view} -x ${cols} -y ${rows}`
    }
    // A lone resize gets no added latency: it fires while idle.
    const first = resize(100, 30)
    expect(execCalls).toEqual([first])
    // A burst (a divider drag emits one frame per column step) coalesces to
    // one queued follow-up, and the last size wins.
    resize(110, 35)
    const last = resize(120, 40)
    expect(execCalls).toEqual([first])
    release()
    await flush()
    expect(execCalls).toEqual([first, last]) // 110x35 never reached the pod
    // The tty is resized every time regardless.
    expect(a.pty.resized).toEqual([[100, 30], [110, 35], [120, 40]])
  })

  it('closing drops a queued resize and kills the view session', async () => {
    const a = attach(job(11), { target: 'agent' })
    await flush()
    execCalls.length = 0

    let release!: () => void
    const gate = new Promise<{ stdout: string; stderr: string }>((r) => {
      release = () => r({ stdout: '', stderr: '' })
    })
    // The kill-session must go through even though the resize is stuck, and
    // "no such session" (closed before the attach landed) is fine.
    execImpl = (cmd) => cmd.includes('resize-window')
      ? gate
      : Promise.reject(new Error('no such session'))

    a.sock.emitMessage('{"type":"resize","cols":100,"rows":30}', false)
    a.sock.emitMessage('{"type":"resize","cols":120,"rows":40}', false) // queued
    a.sock.emitClose()
    release()
    await flush()
    expect(execCalls).toEqual([
      `${TMUX} resize-window -t ${a.view} -x 100 -y 30`,
      `${TMUX} kill-session -t ${a.view}`,
    ])
  })

  it('re-detaches at the grace deadline, then force-kills the PTY', async () => {
    vi.useFakeTimers()
    try {
      const a = attach(job(12), { target: 'agent' })
      await flush()
      execCalls.length = 0

      a.sock.emitClose()
      await flush()
      // Graceful first: the container-side kill-session detaches the client
      // (a plain host-side kill can orphan the in-pod tmux client, pinning
      // the view attached forever). Nothing is written to the PTY — with
      // `prefix None` a detach keystroke would just reach the agent.
      expect(execCalls).toEqual([`${TMUX} kill-session -t ${a.view}`])
      expect(a.pty.written).toEqual([])
      expect(a.pty.killed).toEqual([])

      vi.advanceTimersByTime(DETACH_GRACE_MS)
      await flush()
      // The re-detach catches a socket that closed before the attach landed,
      // and the host-side kill is the final fallback.
      expect(execCalls).toHaveLength(2)
      expect(a.pty.killed).toEqual([undefined])
    } finally {
      vi.useRealTimers()
    }
  })
})
