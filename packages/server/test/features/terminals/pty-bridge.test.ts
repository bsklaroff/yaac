import { describe, it, expect, vi } from 'vitest'
import type * as relayModule from '#platform/k8s/stream-relay'
import { dialPtyStream, sessionExec } from '#platform/k8s/stream-relay'
import { attachArgs, ghostViews, killViewsCmd, killViewSession, listSessionsCmd, makeWindowResizer, newViewName, parseControl, parsePtySize, parsePtyTarget, bridge, resizeWindowCmd, spawnAttachPty, sweepGhostViews } from '#features/terminals/pty-bridge'
import type { PtyLike, SocketLike } from '#features/terminals/pty-bridge'

// Keep the real argv builders; stub only the relay transport.
vi.mock('#platform/k8s/stream-relay', async (importOriginal) => ({
  ...await importOriginal<typeof relayModule>(),
  sessionExec: vi.fn(() => Promise.resolve({ stdout: '', stderr: '' })),
  dialPtyStream: vi.fn(() => ({})),
}))

/** A full-length session Job name (the relay recovers the session id from
 *  its UUID tail). */
const SID = '0f9b2c4d-1111-2222-3333-444455556666'
const JOB = `yaac-demo-${SID}`

/** Every webapp attach creates its per-client grouped view session detached,
 *  with the chrome-less options applied before any client is attached:
 *  `status off`, `prefix None`, and per-view `window-size manual` (which, with
 *  the resize-window below, pins the shared window to this client — set per
 *  view, never globally, since global manual segfaults tmux 3.4). */
const VIEW_CREATE = (view: string, cols: number, rows: number): string =>
  `tmux -S /tmp/yaac-tmux/server new-session -d -t yaac -s ${view} -x ${cols} -y ${rows}`
  + ` \\; set-option -t ${view} status off`
  + ` \\; set-option -t ${view} prefix None`
  + ` \\; set-option -t ${view} window-size manual`

describe('newViewName', () => {
  it('generates unique view-session names', () => {
    expect(newViewName()).toMatch(/^view-[0-9a-f]{8}$/)
    expect(newViewName()).not.toBe(newViewName())
  })
})

describe('attachArgs', () => {
  it('pins the agent target to the lowest-index yaac window and sizes it to the client', () => {
    expect(attachArgs('agent', 'view-11aa22bb', { cols: 150, rows: 40 })).toEqual([
      'sh', '-c',
      'tmux -S /tmp/yaac-tmux/server has-session -t =yaac 2>/dev/null'
      + ` && ${VIEW_CREATE('view-11aa22bb', 150, 40)}`
      + ' && exec tmux -S /tmp/yaac-tmux/server attach-session -t view-11aa22bb'
      + " \\; select-window -t 'view-11aa22bb:^'"
      + ' \\; resize-window -t view-11aa22bb -x 150 -y 40'
      + ' \\; set-option destroy-unattached on',
    ])
  })

  it('builds a window-pinned view argv for window targets, sized to the client', () => {
    const argv = attachArgs('window:@3', 'view-11aa22bb', { cols: 80, rows: 24 })
    expect(argv.slice(0, 2)).toEqual(['sh', '-c'])
    const cmd = argv[2]
    expect(cmd).toContain(VIEW_CREATE('view-11aa22bb', 80, 24))
    expect(cmd).toContain("select-window -t '@3'")
    expect(cmd).toContain('resize-window -t view-11aa22bb -x 80 -y 24')
  })

  it('sets window-size manual per view, never globally (global manual segfaults tmux 3.4)', () => {
    const cmd = attachArgs('agent', 'view-11aa22bb', { cols: 150, rows: 40 })[2]
    expect(cmd).toContain('set-option -t view-11aa22bb window-size manual')
    expect(cmd).not.toContain('set-option -g window-size')
  })

  it('falls back to the 80x24 default size', () => {
    const cmd = attachArgs('agent', 'view-11aa22bb')[2]
    expect(cmd).toContain('new-session -d -t yaac -s view-11aa22bb -x 80 -y 24')
    expect(cmd).toContain('resize-window -t view-11aa22bb -x 80 -y 24')
  })

  it('creates the view detached and sets destroy-unattached only after attaching', () => {
    // `status off` lands while the view is detached, and destroy-unattached
    // must not be set until the client is attached (a detached view with it
    // set could be reaped in the create→attach gap by any other client's
    // detach sweep).
    const cmd = attachArgs('agent', 'view-11aa22bb', {})[2]
    expect(cmd).toMatch(
      /new-session -d [^&]*status off[^&]* && exec [^;]*attach-session[\s\S]*destroy-unattached on$/,
    )
  })

  it('guards the view create on the yaac session existing', () => {
    // Attaching before session-create has built the `yaac` tmux session must
    // fail (so the client retries), not let `new-session -t yaac` mint a
    // stale group whose bare-shell window poisons every subsequent view.
    const cmd = attachArgs('agent', 'view-11aa22bb')[2]
    expect(cmd).toMatch(/^tmux -S \S+ has-session -t =yaac 2>\/dev\/null && /)
  })
})

describe('killViewSession', () => {
  it('kills the view session inside the container', async () => {
    await killViewSession(JOB, 'view-11aa22bb')
    expect(sessionExec).toHaveBeenCalledWith(
      JOB,
      'tmux -S /tmp/yaac-tmux/server kill-session -t view-11aa22bb',
      { maxAttempts: 1 },
    )
  })

  it('swallows exec failures (no such session, pod gone)', async () => {
    vi.mocked(sessionExec).mockRejectedValueOnce(new Error('no such session'))
    await expect(killViewSession(JOB, 'view-11aa22bb')).resolves.toBeUndefined()
  })
})

describe('ghost view sweep', () => {
  it('listSessionsCmd lists session names one per line', () => {
    expect(listSessionsCmd()).toBe("tmux -S /tmp/yaac-tmux/server list-sessions -F '#{session_name}'")
  })

  it('ghostViews keeps only unowned view-shaped names', () => {
    const live = new Set(['view-11aa22bb'])
    expect(ghostViews(
      ['yaac', 'view-11aa22bb', 'view-deadbeef', 'view-nothex!', 'view-badc0ffee', 'my-session'],
      live,
    )).toEqual(['view-deadbeef'])
  })

  it('killViewsCmd chains kills into one tmux invocation', () => {
    expect(killViewsCmd(['view-deadbeef', 'view-aabbccdd'])).toBe(
      'tmux -S /tmp/yaac-tmux/server kill-session -t view-deadbeef'
      + ' \\; kill-session -t view-aabbccdd',
    )
  })

  it('sweepGhostViews kills exactly the ghosts', async () => {
    const calls: string[] = []
    const exec = (_job: string, cmd: string): Promise<{ stdout: string }> => {
      calls.push(cmd)
      return Promise.resolve({ stdout: 'yaac\nview-11aa22bb\nview-deadbeef\n' })
    }
    await sweepGhostViews('yaac-demo', new Set(['view-11aa22bb']), exec)
    expect(calls).toEqual([
      listSessionsCmd(),
      killViewsCmd(['view-deadbeef']),
    ])
  })

  it('sweepGhostViews is a no-op when every view is owned', async () => {
    const calls: string[] = []
    const exec = (_job: string, cmd: string): Promise<{ stdout: string }> => {
      calls.push(cmd)
      return Promise.resolve({ stdout: 'yaac\nview-11aa22bb\n' })
    }
    await sweepGhostViews('yaac-demo', new Set(['view-11aa22bb']), exec)
    expect(calls).toEqual([listSessionsCmd()])
  })

  it('sweepGhostViews swallows exec failures (pod gone, tmux not up)', async () => {
    await expect(
      sweepGhostViews('yaac-demo', new Set(), () => Promise.reject(new Error('no pod'))),
    ).resolves.toBeUndefined()
  })
})

describe('resizeWindowCmd', () => {
  it('builds a resize-window targeting the view', () => {
    expect(resizeWindowCmd('view-11aa22bb', 120, 40)).toBe(
      'tmux -S /tmp/yaac-tmux/server resize-window -t view-11aa22bb -x 120 -y 40',
    )
  })
})

describe('makeWindowResizer', () => {
  it('fires immediately when idle (no added latency)', () => {
    const runs: string[] = []
    const rz = makeWindowResizer('view-11aa22bb', (c) => { runs.push(c); return Promise.resolve() })
    rz.resize(120, 40)
    expect(runs).toEqual([resizeWindowCmd('view-11aa22bb', 120, 40)])
  })

  it('serializes execs: a burst while one is in flight coalesces to the newest size', async () => {
    const runs: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const rz = makeWindowResizer('view-11aa22bb', (c) => {
      runs.push(c)
      return runs.length === 1 ? gate : Promise.resolve()
    })
    rz.resize(100, 30) // in flight, blocked on the gate
    rz.resize(110, 35) // superseded before the follow-up fires
    rz.resize(120, 40) // the one queued follow-up
    expect(runs).toEqual([resizeWindowCmd('view-11aa22bb', 100, 30)])
    release()
    await gate
    await Promise.resolve() // let the completion pump run
    expect(runs).toEqual([
      resizeWindowCmd('view-11aa22bb', 100, 30),
      resizeWindowCmd('view-11aa22bb', 120, 40), // 110x35 never hit the pod
    ])
  })

  it('dispose drops a queued resize (connection closed mid-exec)', async () => {
    const runs: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const rz = makeWindowResizer('view-11aa22bb', (c) => { runs.push(c); return gate })
    rz.resize(100, 30)
    rz.resize(120, 40) // queued
    rz.dispose()
    release()
    await gate
    await Promise.resolve()
    expect(runs).toEqual([resizeWindowCmd('view-11aa22bb', 100, 30)])
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
    const argv = attachArgs('native', 'view-11aa22bb', { cols: 150, rows: 40 })
    const cmd = argv[2]
    expect(cmd).toContain('new-session -d -t yaac -s view-11aa22bb -x 150 -y 40')
    expect(cmd).not.toContain('status off')
    expect(cmd).not.toContain('prefix None')
    expect(cmd).not.toContain('select-window')
    expect(cmd).toMatch(/attach-session -t view-11aa22bb[\s\S]*destroy-unattached on$/)
  })

  it('keeps default (latest) window sizing: no manual, no resize-window', () => {
    // Native has a status bar and lets the user switch windows, so it wants
    // tmux's standard client-driven sizing — the webapp-only pin would fight it.
    const cmd = attachArgs('native', 'view-11aa22bb', { cols: 150, rows: 40 })[2]
    expect(cmd).not.toContain('window-size manual')
    expect(cmd).not.toContain('resize-window')
  })

  it('still guards on the yaac session existing', () => {
    const cmd = attachArgs('native', 'view-11aa22bb')[2]
    expect(cmd).toMatch(/^tmux -S \S+ has-session -t =yaac 2>\/dev\/null && /)
  })
})

describe('spawnAttachPty', () => {
  it('opens a relay pty stream with the attach argv and given size', () => {
    spawnAttachPty(JOB, { cols: 100, rows: 40 }, 'agent', 'view-11aa22bb')
    expect(dialPtyStream).toHaveBeenCalledWith(
      SID,
      attachArgs('agent', 'view-11aa22bb', { cols: 100, rows: 40 }),
      { cols: 100, rows: 40 },
    )
  })

  it('opens a raw zsh pty (no tmux) for the shell target', () => {
    spawnAttachPty(JOB, { cols: 80, rows: 24 }, 'shell', 'view-11aa22bb')
    expect(dialPtyStream).toHaveBeenCalledWith(SID, ['zsh'], { cols: 80, rows: 24 })
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

  it('drives the tmux window resize alongside the PTY tty on resize', () => {
    const pty = new FakePty()
    const sock = new FakeSock()
    const resizeWindow = vi.fn()
    bridge(pty, sock, { resizeWindow })
    sock.emitMessage('{"type":"resize","cols":100,"rows":30}', false)
    expect(pty.resized).toEqual([[100, 30]])
    expect(resizeWindow).toHaveBeenCalledWith(100, 30)
    // only resize frames touch the window
    resizeWindow.mockClear()
    sock.emitMessage('{"type":"ping"}', false)
    expect(resizeWindow).not.toHaveBeenCalled()
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
