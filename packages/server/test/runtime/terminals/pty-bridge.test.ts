/**
 * `attachPty`. Nothing in runtime/terminals is mocked; the fakes are the
 * driver's `dialPty` (the in-workspace PTY) and `exec` (tmux commands).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { attachPty, type SocketLike } from '#runtime/terminals'
import { DETACH_GRACE_MS } from '#runtime/terminals/pty-bridge'
import { installFakeWorkspaceDriver } from '@yaac/test-utils/fake-driver'
import { BATCH_MS } from '@yaac/shared/batcher'
import type { StreamPty, WorkspaceDriver } from '#drivers/contract'

const execMock = vi.fn<WorkspaceDriver['exec']>()
const dialPtyMock = vi.fn<WorkspaceDriver['dialPty']>()

const TMUX = 'tmux -S /tmp/yaac-tmux/server'
const LIST_SESSIONS = `${TMUX} list-sessions -F '#{session_name}'`

/** The live-view registry is server-wide, so tests that must not see each
 *  other's views use different workspace ids. */
const sid = (n: number): string => `0f9b2c4d-1111-2222-3333-4444555566${String(n).padStart(2, '0')}`
const job = (n: number): string => `yaac-demo-${sid(n)}`

/** Each webapp attach creates its own grouped view session, with `status off`
 *  and `prefix None` set before any client attaches. */
const VIEW_CREATE = (view: string, cols: number, rows: number): string =>
  `${TMUX} new-session -d -t yaac -s ${view} -x ${cols} -y ${rows}`
  + ` \\; set-option -t ${view} status off`
  + ` \\; set-option -t ${view} prefix None`

/** Select the view's window before attaching, so tmux sizes it to this
 *  client. */
const VIEW_WINDOW = (window: string): string =>
  ` \\; select-window -t '${window}'`
  + ` \\; set-option -w -t '${window}' window-size latest`

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
  execMock.mockImplementation((_job, cmd) => {
    execCalls.push(cmd)
    return execImpl(cmd)
  })
  dialPtyMock.mockImplementation(() => new FakePty())
  installFakeWorkspaceDriver({ exec: execMock, dialPty: dialPtyMock })
})

/** Drain the background ghost sweep (microtasks only, so fake timers work). */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

interface Attached {
  pty: FakePty
  sock: FakeSock
  jobName: string
  argv: string[]
  size: { cols?: number; rows?: number }
  /** The in-pod command, for non-'shell' targets. */
  cmd: string
  /** The per-client view session this attach created. */
  view: string
}

function attach(
  jobName: string,
  query: { target?: string; cols?: string; rows?: string } = {},
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

describe('attachPty', () => {
  it('attaches the agent window through a fresh, client-sized view session', async () => {
    const a = attach(job(1), { target: 'agent', cols: '150', rows: '40' })
    await flush()

    // The PTY starts at the browser's size, so nothing needs reflowing.
    expect(a.jobName).toBe(job(1))
    expect(a.size).toEqual({ cols: 150, rows: 40 })
    expect(a.argv.slice(0, 2)).toEqual(['sh', '-c'])
    expect(a.view).toMatch(/^view-[0-9a-f]{8}$/)
    expect(a.cmd).toBe(
      // Without has-session, `new-session -t yaac` would create a stray
      // group with a bare shell that later views inherit.
      `${TMUX} has-session -t =yaac 2>/dev/null`
      + ` && ${VIEW_CREATE(a.view, 150, 40)}`
      // The agent is the lowest-index window.
      + VIEW_WINDOW(`${a.view}:^`)
      + ` && exec ${TMUX} attach-session -t ${a.view}`
      // Set after attaching, so the view is not destroyed before then.
      + ' \\; set-option destroy-unattached on',
    )

    // A resize changes only the tty; tmux resizes the window itself.
    execCalls.length = 0
    a.sock.emitMessage('{"type":"resize","cols":100,"rows":30}', false)
    expect(a.pty.resized).toEqual([[100, 30]])
    expect(execCalls).toEqual([])

    expect(attach(job(1), { target: 'agent' }).view).not.toBe(a.view)
  })

  it('pins a window target to that window, defaulting an unusable grid to 80x24', async () => {
    const bad = attach(job(2), { target: 'window:@3', cols: '0', rows: 'abc' })
    await flush()
    expect(bad.size).toEqual({ cols: undefined, rows: undefined })
    expect(bad.cmd).toContain(VIEW_CREATE(bad.view, 80, 24))
    expect(bad.cmd).toContain(VIEW_WINDOW(`${bad.view}:@3`))

    // Out-of-range sizes are dropped per axis; fractions truncate.
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

  it('keeps the tmux chrome and the group\'s own window for the CLI native attach', async () => {
    const a = attach(job(4), { target: 'native', cols: '150', rows: '40' })
    await flush()
    expect(a.cmd).toBe(
      `${TMUX} has-session -t =yaac 2>/dev/null`
      + ` && ${TMUX} new-session -d -t yaac -s ${a.view} -x 150 -y 40`
      + ` && exec ${TMUX} attach-session -t ${a.view}`
      + ' \\; set-option destroy-unattached on',
    )
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
    const a = attach(job(6), { target: 'agent' })
    await flush()
    expect(execCalls).toEqual([LIST_SESSIONS, `${TMUX} kill-session -t view-deadbeef`])

    // A second tab: the first tab's live view is left alone.
    execCalls.length = 0
    listing = ['yaac', a.view, 'view-aabbccdd']
    const b = attach(job(6), { target: 'agent' })
    await flush()
    expect(execCalls).toEqual([LIST_SESSIONS, `${TMUX} kill-session -t view-aabbccdd`])

    // Nothing left to kill, so only the listing runs.
    execCalls.length = 0
    listing = ['yaac', a.view, b.view]
    attach(job(6), { target: 'agent' })
    await flush()
    expect(execCalls).toEqual([LIST_SESSIONS])

    // After both close, the next attach kills both views in one command.
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

      const gone = attach(job(13), { target: 'agent' })
      await flush()
      gone.sock.emitClose()
      await flush()

      // A new connection arrives within the grace window, as on a page reload.
      const live = attach(job(13), { target: 'agent' })
      await flush()

      // The old connection's delayed detach must not remove the new entry.
      vi.advanceTimersByTime(DETACH_GRACE_MS)
      await flush()

      // Otherwise the next sweep would kill the live view, and the two
      // clients would keep killing each other's views.
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

    // The listing works but the kill fails (view or pod already gone).
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

    // Binary input is keystrokes, as a Buffer or ArrayBuffer.
    a.sock.emitMessage(Buffer.from('ls\r', 'utf8'), true)
    a.sock.emitMessage(new TextEncoder().encode('q').buffer, true)
    expect(a.pty.written).toEqual(['ls\r', 'q'])

    a.sock.emitMessage('{"type":"signal","name":"SIGINT"}', false)
    expect(a.pty.killed).toEqual(['SIGINT'])

    a.sock.emitMessage('{"type":"ping"}', false)
    expect(a.sock.sent).toContain('{"type":"pong"}')

    // The pong echoes the ping's timestamp so the browser can measure latency.
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
    expect(a.pty.resized).toEqual([])

    // PTY exit closes the socket.
    a.pty.emitExit(3)
    expect(a.sock.closed).toEqual([[1000, 'pty exited (3)']])
  })

  it('coalesces an output burst into one frame per window, flushing before the close', async () => {
    // Fake timers first: the batcher captures the clock when created.
    vi.useFakeTimers()
    try {
      const a = attach(job(14), { target: 'agent' })
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
    const a = attach(job(9), { target: 'agent' })
    await flush()
    a.sock.throwOnUse = true
    // Must not throw, since the close handler is what kills the PTY.
    expect(() => a.pty.emitData('hello')).not.toThrow()
    expect(() => a.pty.emitExit(1)).not.toThrow()
  })

  it('closing kills the view session, tolerating one already gone', async () => {
    const a = attach(job(11), { target: 'agent' })
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
      const a = attach(job(12), { target: 'agent' })
      await flush()
      execCalls.length = 0

      a.sock.emitClose()
      await flush()
      // First an in-pod kill-session; killing only the host side could leave
      // the tmux client attached. Nothing is typed into the PTY, since with
      // `prefix None` a detach key would reach the agent.
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
