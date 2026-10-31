import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { installFakeWorkspaceDriver, handleFixture } from '#test/support/fake-driver'
import {
  WorkspaceStatusWatcher,
  StatusWatcherManager,
} from '#runtime/status/status-watcher'
import type { RuntimeHandle, StreamChild } from '#drivers/contract'
import type { WatchedSession } from '#runtime/agents'
import type { AgentTool } from '@yaac/shared/types'
import {
  liveAgents,
  readWorkspaceStatus,
  readWorkspaceWindows,
  isWorkspaceStreamHealthy,
  setAgentStatus,
  setWorkspaceWindows,
  _resetWorkspaceStatusStoreForTests,
} from '#runtime/status/status-store'
import { parkAcpQueue, takeAcpQueue } from '#runtime/agents/acp-registry'
import type { QueuedTurn } from '#runtime/agents/acp-client'

/** The workspace's tmux, as the fake streams answer for it. */
interface FakeTmux {
  panes: Array<{ paneId: string; window: string; dead?: boolean }>
  windows: Array<{ id: string; name: string; dead?: boolean }>
  /** Leave heartbeats unanswered. */
  silent?: boolean
}

/**
 * One dialed control-mode stream. With a `tmux` it answers each command the
 * way tmux would, in order; without one a test feeds replies itself.
 */
class FakeAttachChild implements StreamChild {
  writes: string[] = []
  killed = false
  private stdoutCbs: Array<(chunk: Buffer | string) => void> = []
  private exitCbs: Array<(...args: unknown[]) => void> = []
  constructor(private readonly tmux?: FakeTmux) {
    if (tmux) setTimeout(() => this.feedBanner(), 0)
  }
  stdin = {
    write: (data: string): void => {
      this.writes.push(data)
      if (!this.tmux) return
      for (const cmd of data.split('\n').filter((l) => l !== '')) {
        const reply = answer(this.tmux, cmd)
        if (reply !== null) setTimeout(() => this.feedReply(reply), 0)
      }
    },
  }
  stdout = { on: (_e: 'data', cb: (chunk: Buffer | string) => void): void => { this.stdoutCbs.push(cb) } }
  stderr = { on: (): void => { /* unused */ } }
  on(event: 'exit' | 'error', cb: (...args: unknown[]) => void): void {
    if (event === 'exit') this.exitCbs.push(cb)
  }
  kill(): boolean {
    this.killed = true
    return true
  }
  feed(data: string): void {
    for (const cb of this.stdoutCbs) cb(data)
  }
  feedBanner(): void {
    this.feed('%begin 1 100 0\n%end 1 100 0\n%session-changed $0 yaac\n')
  }
  feedReply(body: string): void {
    this.feed(`%begin 1 101 1\n${body === '' ? '' : `${body}\n`}%end 1 101 1\n`)
  }
  emitExit(): void {
    for (const cb of this.exitCbs) cb(0)
  }
  get sent(): string {
    return this.writes.join('')
  }
}

/** What tmux answers to one command, or null for none. */
function answer(tmux: FakeTmux, cmd: string): string | null {
  if (cmd.startsWith('list-panes')) {
    return tmux.panes.map((p) => `${p.paneId}\t${p.window}\t${p.dead === true ? 1 : 0}\t`).join('\n')
  }
  if (cmd.startsWith("list-windows -t yaac -F '#{window_id}")) {
    return tmux.windows.map((w) => `${w.id}|${w.dead === true ? 1 : 0}|${w.name}`).join('\n')
  }
  if (cmd.startsWith('list-windows')) {
    return tmux.windows.map((w) => `${w.name}\t%${w.id.slice(1)}\t${w.dead === true ? 1 : 0}\t100\t`).join('\n')
  }
  if (cmd.startsWith('display-message -p ok')) return tmux.silent === true ? null : 'ok'
  return ''
}

const WS = { projectId: 'demo', workspaceId: 's1', jobName: 'yaac-demo-s1' }

/** A `tui` session in `window`. */
function tuiSession(window: string, tool: AgentTool = 'claude'): WatchedSession {
  return { window, tool, mode: 'tui', sessionId: `id-${window}`, permissionMode: 'bypass' }
}

function makeWatcher(opts: {
  tmux?: FakeTmux
  sessions?: WatchedSession[]
  heartbeatIntervalMs?: number
  commandTimeoutMs?: number
  respawnDelayMs?: number
} = {}): { watcher: WorkspaceStatusWatcher; children: FakeAttachChild[]; revives: string[] } {
  const children: FakeAttachChild[] = []
  const revives: string[] = []
  const watcher = new WorkspaceStatusWatcher(WS, {
    dial: () => {
      const child = new FakeAttachChild(opts.tmux)
      children.push(child)
      return child
    },
    sessions: () => Promise.resolve(opts.sessions ?? []),
    // Injected so no test starts a real streamd.
    reviveStreamd: (jobName) => {
      revives.push(jobName)
      return Promise.resolve()
    },
    heartbeatIntervalMs: opts.heartbeatIntervalMs ?? 60_000,
    commandTimeoutMs: opts.commandTimeoutMs ?? 1_000,
    respawnDelayMs: opts.respawnDelayMs ?? 5,
    maxRespawnDelayMs: 20,
    log: () => { /* quiet */ },
  })
  watchers.push(watcher)
  return { watcher, children, revives }
}

/** A claude `tui` session's agent on pane `%7`, beside the keeper. */
function claudeTmux(): FakeTmux {
  return {
    panes: [{ paneId: '%0', window: '_yaac' }, { paneId: '%7', window: 'claude-aaaa' }],
    windows: [{ id: '@0', name: '_yaac' }, { id: '@1', name: 'claude-aaaa' }],
  }
}

/** Both streams up and the windows listed. */
async function connected(): Promise<void> {
  await vi.waitFor(() => expect(isWorkspaceStreamHealthy('demo', 's1')).toBe(true))
  await vi.waitFor(() => expect(readWorkspaceWindows('demo', 's1')).toBeDefined())
  await vi.waitFor(() => expect(liveAgents('demo', 's1')).toBeDefined())
}

let watchers: WorkspaceStatusWatcher[] = []

beforeEach(() => {
  _resetWorkspaceStatusStoreForTests()
  // Supplies the workspace's tmux socket path for the attach command.
  installFakeWorkspaceDriver()
})

afterEach(() => {
  for (const w of watchers) w.stop()
  watchers = []
})

describe('WorkspaceStatusWatcher', () => {
  it("dials one stream per mode, and subscribes a tui session's agent pane under its window", async () => {
    const { watcher, children } = makeWatcher({ tmux: claudeTmux(), sessions: [tuiSession('claude-aaaa')] })
    watcher.start()
    await connected()
    expect(children).toHaveLength(2)
    const tui = children[0].sent
    expect(tui).toContain("list-panes -s -F '#{pane_id}\t#{window_name}\t#{pane_dead}\t#{=1024;s/[^ -~]//:@yaac-session}' -t yaac")
    // Includes the pane id, since same-name subscriptions replace each other.
    expect(tui).toContain("refresh-client -B 'status-7:%7:#{pane_title}'")
    expect(tui).toContain("refresh-client -B 'dead-7:%7:#{pane_dead}'")
    // The keeper runs no agent.
    expect(tui).not.toContain('status-0')
    expect(liveAgents('demo', 's1')).toEqual([{ handle: 'claude-aaaa', tool: 'claude' }])
    // No status yet reads as waiting.
    expect(readWorkspaceStatus('demo', 's1')).toBe('waiting')
  })

  it('classifies pushed title values under the session window, ignoring other panes and names', async () => {
    const { watcher, children } = makeWatcher({ tmux: claudeTmux(), sessions: [tuiSession('claude-aaaa')] })
    watcher.start()
    await connected()
    const tui = children[0]

    tui.feed('%subscription-changed status-7 $0 @0 0 %7 : ⠋ working\n')
    expect(readWorkspaceStatus('demo', 's1')).toBe('running')
    tui.feed('%subscription-changed status-7 $0 @0 0 %7 : ✳ done\n')
    expect(readWorkspaceStatus('demo', 's1')).toBe('waiting')

    tui.feed('%subscription-changed status-9 $0 @0 0 %9 : ⠋ other pane\n')
    tui.feed('%subscription-changed other $0 @0 0 %7 : ⠋ other name\n')
    expect(readWorkspaceStatus('demo', 's1')).toBe('waiting')
  })

  // An agent that exits keeps its pane (`remain-on-exit`); the death push
  // re-lists, and the listing drops it from the live set.
  it('drops an exited agent from the live set when its pane dies', async () => {
    const tmux = claudeTmux()
    const { watcher, children } = makeWatcher({ tmux, sessions: [tuiSession('claude-aaaa')] })
    watcher.start()
    await connected()
    tmux.panes[1].dead = true
    tmux.windows[1].dead = true
    children[0].feed('%subscription-changed dead-7 $0 @0 0 %7 : 1\n')
    await vi.waitFor(() => expect(liveAgents('demo', 's1')).toEqual([]))
    await vi.waitFor(() => expect(readWorkspaceWindows('demo', 's1')?.[1]).toEqual({ id: '@1', name: 'claude-aaaa', dead: true }))
  })

  it('lists the windows as the streams come up and on each window event, and keeps them across a drop', async () => {
    const tmux = claudeTmux()
    const { watcher, children } = makeWatcher({ tmux, sessions: [tuiSession('claude-aaaa')] })
    watcher.start()
    await connected()
    expect(readWorkspaceWindows('demo', 's1')).toEqual([
      { id: '@0', name: '_yaac', dead: false },
      { id: '@1', name: 'claude-aaaa', dead: false },
    ])
    expect(children[0].sent).toContain("list-windows -t yaac -F '#{window_id}|#{pane_dead}|#{window_name}'")

    tmux.windows.push({ id: '@2', name: 'shell' })
    children[0].feed('%window-add @2\n')
    await vi.waitFor(() => expect(readWorkspaceWindows('demo', 's1')?.map((w) => w.name)).toEqual(['_yaac', 'claude-aaaa', 'shell']))
    tmux.windows[2].name = 'build'
    children[0].feed('%window-renamed @2 build\n')
    await vi.waitFor(() => expect(readWorkspaceWindows('demo', 's1')?.[2]?.name).toBe('build'))

    // A dropped stream keeps the last listing.
    children[0].emitExit()
    expect(readWorkspaceWindows('demo', 's1')?.map((w) => w.name)).toEqual(['_yaac', 'claude-aaaa', 'build'])
  })

  // The acp lane watches only acp sessions' windows; a tui one is the tui
  // lane's, so the acp lane never dials its acpd socket.
  it("leaves each mode's windows to its own stream", async () => {
    const tmux = claudeTmux()
    const { watcher, children } = makeWatcher({ tmux, sessions: [tuiSession('claude-aaaa')] })
    watcher.start()
    await connected()
    expect(children).toHaveLength(2)
    expect(children[1].sent).toContain("list-windows -t yaac -F '#{window_name}")
    expect(children[1].sent).not.toContain('refresh-client -B')
  })

  it('keeps status sticky and flips health when a stream drops, then respawns that stream', async () => {
    const { watcher, children } = makeWatcher({ tmux: claudeTmux(), sessions: [tuiSession('claude-aaaa')] })
    watcher.start()
    await connected()
    children[0].feed('%subscription-changed status-7 $0 @0 0 %7 : ⠋ working\n')
    expect(readWorkspaceStatus('demo', 's1')).toBe('running')

    children[0].emitExit()
    expect(isWorkspaceStreamHealthy('demo', 's1')).toBe(false)
    expect(readWorkspaceStatus('demo', 's1')).toBe('running') // sticky

    // Only the dropped stream is dialed again.
    await vi.waitFor(() => expect(children).toHaveLength(3))
    await vi.waitFor(() => expect(isWorkspaceStreamHealthy('demo', 's1')).toBe(true))
    expect(children[1].killed).toBe(false)
  })

  it('tears down and respawns a stream whose heartbeat gets no reply', async () => {
    const tmux = { ...claudeTmux(), silent: true }
    const { watcher, children } = makeWatcher({
      tmux, sessions: [tuiSession('claude-aaaa')], heartbeatIntervalMs: 10, commandTimeoutMs: 250,
    })
    watcher.start()
    await vi.waitFor(() => expect(children.length).toBeGreaterThanOrEqual(3))
    expect(children[0].killed || children[1].killed).toBe(true)
  })

  it('stays connected while heartbeats are answered', async () => {
    const { watcher, children } = makeWatcher({
      tmux: claudeTmux(), sessions: [tuiSession('claude-aaaa')], heartbeatIntervalMs: 15, commandTimeoutMs: 200,
    })
    watcher.start()
    await connected()
    await vi.waitFor(() => expect(children[0].sent).toContain('display-message -p ok'))
    await new Promise((r) => setTimeout(r, 40))
    expect(children).toHaveLength(2)
    expect(isWorkspaceStreamHealthy('demo', 's1')).toBe(true)
  })

  it('respawns a stream whose first listing fails', async () => {
    const { watcher, children } = makeWatcher()
    watcher.start()
    const tui = children[0]
    tui.feedBanner()
    await vi.waitFor(() => expect(tui.writes).toHaveLength(1))
    tui.feed('%begin 1 101 1\ncan\'t find session\n%error 1 101 1\n')
    await vi.waitFor(() => expect(children).toHaveLength(3))
  })

  it('re-execs streamd (self-heal) every third consecutive failure of a stream', async () => {
    const { watcher, children, revives } = makeWatcher({ respawnDelayMs: 1 })
    watcher.start()
    // The tui stream is dialed first each time; the acp one stays pending.
    let tui = children[0]
    for (let i = 0; i < 3; i++) {
      tui.emitExit()
      const before = children.length
      await vi.waitFor(() => expect(children.length).toBe(before + 1))
      tui = children[children.length - 1]
    }
    expect(revives).toEqual(['yaac-demo-s1'])
  })

  it('stop() kills the streams, prevents respawn, and discards chat messages parked for a reconnect', async () => {
    const { watcher, children } = makeWatcher({ tmux: claudeTmux(), sessions: [tuiSession('claude-aaaa')], respawnDelayMs: 1 })
    watcher.start()
    await connected()
    // A chat's queue parked by a dropped connection would otherwise be sent
    // when the workspace is next resumed.
    const reject = vi.fn()
    const turn: QueuedTurn = { id: 'q1', text: 'stale', images: 0, blocks: [], resolve: () => {}, reject }
    parkAcpQueue('demo', 's1', 'acp-1', [turn])
    watcher.stop()
    expect(children.every((c) => c.killed)).toBe(true)
    expect(reject).toHaveBeenCalled()
    expect(takeAcpQueue('demo', 's1', 'acp-1')).toEqual([])
    children[0].emitExit()
    await new Promise((r) => setTimeout(r, 20))
    expect(children).toHaveLength(2)
  })
})

describe('WorkspaceStatusWatcher (pane tools)', () => {
  const opencodeTmux = (): FakeTmux => ({
    panes: [{ paneId: '%2', window: 'opencode-bbbb' }],
    windows: [{ id: '@2', name: 'opencode-bbbb' }],
  })

  it('subscribes opencode to its tmux-side busy format (no capture-pane, no %output)', async () => {
    const { watcher, children } = makeWatcher({ tmux: opencodeTmux(), sessions: [tuiSession('opencode-bbbb', 'opencode')] })
    watcher.start()
    await connected()
    // tmux itself searches the pane content; nothing is captured.
    await vi.waitFor(() => expect(children[0].sent).toContain("refresh-client -B 'status-2:%2:#{?#{||:#{C/ri:"))
    expect(children[0].sent).not.toContain('capture-pane')
  })

  it('records the verdict pushed by the tmux-side subscription', async () => {
    const tmux: FakeTmux = { panes: [{ paneId: '%2', window: 'pi-cccc' }], windows: [{ id: '@2', name: 'pi-cccc' }] }
    const { watcher, children } = makeWatcher({ tmux, sessions: [tuiSession('pi-cccc', 'pi')] })
    watcher.start()
    await connected()
    // opencode/pi report the status word directly.
    children[0].feed('%subscription-changed status-2 $0 @0 0 %2 : running\n')
    expect(readWorkspaceStatus('demo', 's1')).toBe('running')
    children[0].feed('%subscription-changed status-2 $0 @0 0 %2 : waiting\n')
    expect(readWorkspaceStatus('demo', 's1')).toBe('waiting')
  })

  it('ignores stray %output (the watcher attaches no-output, so it never re-captures)', async () => {
    const { watcher, children } = makeWatcher({ tmux: opencodeTmux(), sessions: [tuiSession('opencode-bbbb', 'opencode')] })
    watcher.start()
    await connected()
    const before = children[0].writes.length
    children[0].feed('%output %2 leftover redraw bytes\n')
    await new Promise((r) => setTimeout(r, 25))
    expect(children[0].writes.slice(before).join('')).not.toContain('capture-pane')
  })
})

function workspace(opts: { workspaceId: string; running?: boolean; prewarmed?: boolean }): RuntimeHandle {
  return handleFixture({
    workspaceId: opts.workspaceId,
    projectId: 'demo',
    jobName: `yaac-demo-${opts.workspaceId}`,
    running: opts.running !== false,
    state: opts.running === false ? 'pending' : 'running',
    prewarmed: opts.prewarmed ?? false,
  })
}

describe('StatusWatcherManager', () => {
  function makeManager(): { manager: StatusWatcherManager; children: FakeAttachChild[] } {
    const children: FakeAttachChild[] = []
    const manager = new StatusWatcherManager({
      dial: () => {
        const child = new FakeAttachChild()
        children.push(child)
        return child
      },
      respawnDelayMs: 5,
      log: () => { /* quiet */ },
    })
    return { manager, children }
  }

  // A spare runs no session, so there is nothing to watch until a claim.
  it('starts a watcher per running workspace, and none for a spare', () => {
    const { manager, children } = makeManager()
    try {
      manager.sync([
        workspace({ workspaceId: 's1' }),
        workspace({ workspaceId: 's2', running: false }),
        workspace({ workspaceId: 's3', prewarmed: true }),
      ])
      expect(manager.size).toBe(1)
      expect(children).toHaveLength(2)
    } finally {
      manager.stopAll()
    }
  })

  it('is idempotent for an unchanged pod set', () => {
    const { manager, children } = makeManager()
    try {
      manager.sync([workspace({ workspaceId: 's1' })])
      manager.sync([workspace({ workspaceId: 's1' })])
      expect(manager.size).toBe(1)
      expect(children).toHaveLength(2)
    } finally {
      manager.stopAll()
    }
  })

  it('stops the watcher and evicts the store entry when the pod goes away', () => {
    const { manager, children } = makeManager()
    try {
      manager.sync([workspace({ workspaceId: 's1' })])
      setAgentStatus('demo', 's1', 'claude-aaaa', 'running')
      setWorkspaceWindows('demo', 's1', [{ id: '@1', name: 'shell', dead: false }])
      manager.sync([])
      expect(manager.size).toBe(0)
      expect(children.every((c) => c.killed)).toBe(true)
      expect(readWorkspaceStatus('demo', 's1')).toBe('waiting')
      expect(readWorkspaceWindows('demo', 's1')).toBeUndefined()
    } finally {
      manager.stopAll()
    }
  })

  it('starts a watcher when a claimed spare loses its prewarm label', () => {
    const { manager } = makeManager()
    try {
      manager.sync([workspace({ workspaceId: 's1', prewarmed: true })])
      expect(manager.size).toBe(0)
      manager.sync([workspace({ workspaceId: 's1' })])
      expect(manager.size).toBe(1)
    } finally {
      manager.stopAll()
    }
  })

  it('stopAll kills every watcher', () => {
    const { manager, children } = makeManager()
    manager.sync([workspace({ workspaceId: 's1' }), workspace({ workspaceId: 's2' })])
    expect(manager.size).toBe(2)
    manager.stopAll()
    expect(manager.size).toBe(0)
    expect(children.every((c) => c.killed)).toBe(true)
  })
})
