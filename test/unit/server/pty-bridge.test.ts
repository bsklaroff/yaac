import { describe, it, expect, vi } from 'vitest'
import * as pty from '@lydell/node-pty'
import type * as execModule from '@/lib/k8s/exec'
import { containerExec } from '@/lib/k8s/exec'
import { attachArgs, killViewSession, newViewName, parseControl, parsePtySize, parsePtyTarget, bridge, spawnAttachPty } from '@/server/pty-bridge'
import type { PtyLike, SocketLike } from '@/server/pty-bridge'

// Avoid loading/spawning the real node-pty native module in unit tests.
vi.mock('@lydell/node-pty', () => ({ spawn: vi.fn(() => ({})) }))
// Keep the real argv builders; stub only the kubectl-exec runner.
vi.mock('@/lib/k8s/exec', async (importOriginal) => ({
  ...await importOriginal<typeof execModule>(),
  containerExec: vi.fn(() => Promise.resolve({ stdout: '', stderr: '' })),
}))

/** Every webapp attach creates its per-client grouped view session detached,
 *  with the chrome-less options applied before any client is attached —
 *  `status off` while detached is what keeps the attach a single window
 *  resize (the attached-create shape sized the window twice, eating the row
 *  below the agent's cursor when the agent missed the net-zero resize). */
const VIEW_CREATE = (view: string, cols: number, rows: number): string =>
  `tmux -S /tmp/yaac-tmux/server new-session -d -t yaac -s ${view} -x ${cols} -y ${rows}`
  + ` \\; set-option -t ${view} status off`
  + ` \\; set-option -t ${view} prefix None`

describe('newViewName', () => {
  it('generates unique view-session names', () => {
    expect(newViewName()).toMatch(/^view-[0-9a-f]{8}$/)
    expect(newViewName()).not.toBe(newViewName())
  })
})

describe('attachArgs', () => {
  it('pins the agent target to the lowest-index yaac window via a view session', () => {
    expect(attachArgs('yaac-demo-abc', 'agent', 'view-11aa22bb', { cols: 150, rows: 40 })).toEqual([
      'exec', '-n', 'yaac', '-it', 'job/yaac-demo-abc', '--',
      'sh', '-c',
      'tmux -S /tmp/yaac-tmux/server has-session -t =yaac 2>/dev/null'
      + ` && ${VIEW_CREATE('view-11aa22bb', 150, 40)}`
      + ' && exec tmux -S /tmp/yaac-tmux/server attach-session -t view-11aa22bb'
      + " \\; select-window -t 'view-11aa22bb:^'"
      + ' \\; set-option destroy-unattached on',
    ])
  })

  it('builds a window-pinned view argv for window targets', () => {
    const argv = attachArgs('yaac-demo-abc', 'window:@3', 'view-11aa22bb', { cols: 80, rows: 24 })
    expect(argv.slice(0, 7)).toEqual([
      'exec', '-n', 'yaac', '-it', 'job/yaac-demo-abc', '--', 'sh',
    ])
    const cmd = argv[8]
    expect(cmd).toContain(VIEW_CREATE('view-11aa22bb', 80, 24))
    expect(cmd).toContain("select-window -t '@3'")
  })

  it('falls back to the 80x24 default size', () => {
    const cmd = attachArgs('yaac-demo-abc', 'agent', 'view-11aa22bb')[8]
    expect(cmd).toContain('new-session -d -t yaac -s view-11aa22bb -x 80 -y 24')
  })

  it('creates the view detached and sets destroy-unattached only after attaching', () => {
    // Order matters twice over: `status off` must land while the view is
    // detached (so attaching resizes the shared window exactly once, to the
    // client size — no status-bar row intermediate), and destroy-unattached
    // must not be set until the client is attached (a detached view with it
    // set could be reaped in the create→attach gap by any other client's
    // detach sweep).
    const cmd = attachArgs('yaac-demo-abc', 'agent', 'view-11aa22bb', {})[8]
    expect(cmd).toMatch(
      /new-session -d [^&]*status off[^&]* && exec [^;]*attach-session[\s\S]*destroy-unattached on$/,
    )
  })

  it('guards the view create on the yaac session existing', () => {
    // Attaching before session-create has built the `yaac` tmux session must
    // fail (so the client retries), not let `new-session -t yaac` mint a
    // stale group whose bare-shell window poisons every subsequent view.
    const cmd = attachArgs('yaac-demo-abc', 'agent', 'view-11aa22bb')[8]
    expect(cmd).toMatch(/^tmux -S \S+ has-session -t =yaac 2>\/dev\/null && /)
  })
})

describe('killViewSession', () => {
  it('kills the view session inside the container', async () => {
    await killViewSession('yaac-demo-abc', 'view-11aa22bb')
    expect(containerExec).toHaveBeenCalledWith(
      'yaac-demo-abc',
      'tmux -S /tmp/yaac-tmux/server kill-session -t view-11aa22bb',
      { maxAttempts: 1 },
    )
  })

  it('swallows exec failures (no such session, pod gone)', async () => {
    vi.mocked(containerExec).mockRejectedValueOnce(new Error('no such session'))
    await expect(killViewSession('yaac-demo-abc', 'view-11aa22bb')).resolves.toBeUndefined()
  })
})

describe('parsePtyTarget', () => {
  it('validates targets, defaulting to agent', () => {
    expect(parsePtyTarget('agent')).toBe('agent')
    expect(parsePtyTarget('window:@7')).toBe('window:@7')
    // CLI targets: full-chrome grouped attach and the raw zsh exec.
    expect(parsePtyTarget('native')).toBe('native')
    expect(parsePtyTarget('shell')).toBe('shell')
  })

  it('rejects malformed or injected targets', () => {
    expect(parsePtyTarget(undefined)).toBe('agent')
    expect(parsePtyTarget(42)).toBe('agent')
    expect(parsePtyTarget('window:7')).toBe('agent')
    expect(parsePtyTarget('window:@x')).toBe('agent')
    expect(parsePtyTarget('shell:shell')).toBe('agent')
    expect(parsePtyTarget("window:@1' \\; kill-server")).toBe('agent')
  })
})

describe('attachArgs (native)', () => {
  it('keeps the tmux chrome: no status-off, no prefix-none, no select-window', () => {
    const argv = attachArgs('yaac-demo-abc', 'native', 'view-11aa22bb', { cols: 150, rows: 40 })
    const cmd = argv[8]
    expect(cmd).toContain('new-session -d -t yaac -s view-11aa22bb -x 150 -y 40')
    expect(cmd).not.toContain('status off')
    expect(cmd).not.toContain('prefix None')
    expect(cmd).not.toContain('select-window')
    expect(cmd).toMatch(/attach-session -t view-11aa22bb[\s\S]*destroy-unattached on$/)
  })

  it('still guards on the yaac session existing', () => {
    const cmd = attachArgs('yaac-demo-abc', 'native', 'view-11aa22bb')[8]
    expect(cmd).toMatch(/^tmux -S \S+ has-session -t =yaac 2>\/dev\/null && /)
  })
})

describe('spawnAttachPty', () => {
  it('spawns `kubectl` under a PTY with the attach argv and given size', () => {
    spawnAttachPty('yaac-demo', { cols: 100, rows: 40 }, 'agent', 'view-11aa22bb')
    expect(pty.spawn).toHaveBeenCalledWith(
      'kubectl',
      attachArgs('yaac-demo', 'agent', 'view-11aa22bb', { cols: 100, rows: 40 }),
      expect.objectContaining({ name: 'xterm-color', cols: 100, rows: 40 }),
    )
  })

  it('spawns a raw zsh exec (no tmux) for the shell target', () => {
    spawnAttachPty('yaac-demo', { cols: 80, rows: 24 }, 'shell', 'view-11aa22bb')
    expect(pty.spawn).toHaveBeenCalledWith(
      'kubectl',
      ['exec', '-n', 'yaac', '-it', 'job/yaac-demo', '--', 'zsh'],
      expect.objectContaining({ name: 'xterm-color', cols: 80, rows: 24 }),
    )
  })
})

describe('parsePtySize', () => {
  it('coerces valid numeric strings to a size', () => {
    expect(parsePtySize('150', '40')).toEqual({ cols: 150, rows: 40 })
  })

  it('accepts numbers and truncates fractions', () => {
    expect(parsePtySize(150.9, 40.2)).toEqual({ cols: 150, rows: 40 })
  })

  it('drops missing, non-numeric, non-positive, or oversized values', () => {
    expect(parsePtySize(undefined, undefined)).toEqual({ cols: undefined, rows: undefined })
    expect(parsePtySize('abc', '40')).toEqual({ cols: undefined, rows: 40 })
    expect(parsePtySize('0', '-5')).toEqual({ cols: undefined, rows: undefined })
    expect(parsePtySize('5000', '40')).toEqual({ cols: undefined, rows: 40 })
  })
})

describe('parseControl', () => {
  it('parses resize / signal / ping', () => {
    expect(parseControl('{"type":"resize","cols":120,"rows":40}')).toEqual({
      type: 'resize', cols: 120, rows: 40,
    })
    expect(parseControl('{"type":"signal","name":"SIGINT"}')).toEqual({ type: 'signal', name: 'SIGINT' })
    expect(parseControl('{"type":"ping"}')).toEqual({ type: 'ping' })
  })

  it('returns null for invalid JSON, non-objects, and unknown types', () => {
    expect(parseControl('not json')).toBeNull()
    expect(parseControl('42')).toBeNull()
    expect(parseControl('null')).toBeNull()
    expect(parseControl('{"type":"nope"}')).toBeNull()
  })
})

class FakePty implements PtyLike {
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
  private msgCb?: (data: string | Buffer | ArrayBuffer, isBinary: boolean) => void
  private closeCb?: () => void
  send(d: string | Uint8Array): void { this.sent.push(d) }
  close(code?: number, reason?: string): void { this.closed.push([code, reason]) }
  onMessage(cb: (data: string | Buffer | ArrayBuffer, isBinary: boolean) => void): void { this.msgCb = cb }
  onClose(cb: () => void): void { this.closeCb = cb }
  emitMessage(data: string | Buffer, isBinary: boolean): void { this.msgCb?.(data, isBinary) }
  emitClose(): void { this.closeCb?.() }
}

describe('bridge', () => {
  it('streams PTY output to the socket as bytes', () => {
    const pty = new FakePty()
    const sock = new FakeSock()
    bridge(pty, sock)
    pty.emitData('hello')
    expect(sock.sent).toHaveLength(1)
    expect(Buffer.from(sock.sent[0] as Uint8Array).toString('utf8')).toBe('hello')
  })

  it('writes binary input frames to the PTY', () => {
    const pty = new FakePty()
    const sock = new FakeSock()
    bridge(pty, sock)
    sock.emitMessage(Buffer.from('ls\r', 'utf8'), true)
    expect(pty.written).toEqual(['ls\r'])
  })

  it('applies resize control frames', () => {
    const pty = new FakePty()
    const sock = new FakeSock()
    bridge(pty, sock)
    sock.emitMessage('{"type":"resize","cols":100,"rows":30}', false)
    expect(pty.resized).toEqual([[100, 30]])
  })

  it('replies to ping with pong', () => {
    const pty = new FakePty()
    const sock = new FakeSock()
    bridge(pty, sock)
    sock.emitMessage('{"type":"ping"}', false)
    expect(sock.sent).toContain('{"type":"pong"}')
  })

  it('forwards signal control frames to the PTY', () => {
    const pty = new FakePty()
    const sock = new FakeSock()
    bridge(pty, sock)
    sock.emitMessage('{"type":"signal","name":"SIGINT"}', false)
    expect(pty.killed).toEqual(['SIGINT'])
  })

  it('detaches on socket close, re-detaches at the grace deadline, then force-kills the PTY', () => {
    vi.useFakeTimers()
    try {
      const pty = new FakePty()
      const sock = new FakeSock()
      const detach = vi.fn()
      bridge(pty, sock, { detach, detachGraceMs: 400 })
      sock.emitClose()
      // Graceful: the container-side kill-session detaches the client (a
      // plain host-side kill can orphan the remote tmux client, pinning the
      // view session attached forever). Nothing is written to the PTY —
      // with `prefix None` a detach keystroke would just reach the agent.
      expect(detach).toHaveBeenCalledTimes(1)
      expect(pty.written).toEqual([])
      expect(pty.killed).toEqual([])
      vi.advanceTimersByTime(400)
      // The re-detach catches a socket that closed before the attach landed.
      expect(detach).toHaveBeenCalledTimes(2)
      expect(pty.killed).toEqual([undefined])
    } finally {
      vi.useRealTimers()
    }
  })

  it('force-kills the PTY after the grace even without a detach callback', () => {
    vi.useFakeTimers()
    try {
      const pty = new FakePty()
      const sock = new FakeSock()
      bridge(pty, sock, { detachGraceMs: 400 })
      sock.emitClose()
      vi.advanceTimersByTime(400)
      expect(pty.killed).toEqual([undefined])
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes the socket when the PTY exits', () => {
    const pty = new FakePty()
    const sock = new FakeSock()
    bridge(pty, sock)
    pty.emitExit(0)
    expect(sock.closed).toHaveLength(1)
    expect(sock.closed[0][0]).toBe(1000)
  })
})
