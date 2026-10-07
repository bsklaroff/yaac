import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { installFakeWorkspaceDriver } from '@yaac/test-utils/fake-driver'

import {
  WorkspaceStatusWatcher,
  StatusWatcherManager,
  type WatchedWorkspace,
} from '#runtime/status/status-watcher'
import type { RuntimeHandle, StreamChild } from '#drivers/contract'
import { handleFixture } from '@yaac/test-utils/fake-driver'
import type { AgentMode, AgentTool } from '@yaac/shared/types'
import {
  readWorkspaceStatus,
  readWorkspaceTerminals,
  isWorkspaceStreamHealthy,
  setAgentStatus,
  setWorkspaceTerminals,
  _resetWorkspaceStatusStoreForTests,
} from '#runtime/status/status-store'
import { parkAcpQueue, takeAcpQueue } from '#runtime/agents/acp-registry'
import type { QueuedTurn } from '#runtime/agents/acp-client'

class FakeAttachChild implements StreamChild {
  writes: string[] = []
  killed = false
  private stdoutCbs: Array<(chunk: Buffer | string) => void> = []
  private exitCbs: Array<(...args: unknown[]) => void> = []
  stdin = {
    write: (data: string): void => {
      this.writes.push(data)
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
  /** Number of commands written so far (one line each). */
  get commandCount(): number {
    return this.writes.join('').split('\n').filter((l) => l !== '').length
  }
}

function session(tool: WatchedWorkspace['tool']): WatchedWorkspace {
  return { projectId: 'demo', workspaceId: 's1', jobName: 'yaac-demo-s1', tool, mode: 'tui' }
}

function makeWatcher(tool: WatchedWorkspace['tool'], deps: {
  heartbeatIntervalMs?: number
  commandTimeoutMs?: number
  respawnDelayMs?: number
} = {}): { watcher: WorkspaceStatusWatcher; children: FakeAttachChild[]; revives: string[] } {
  const children: FakeAttachChild[] = []
  const revives: string[] = []
  const watcher = new WorkspaceStatusWatcher(session(tool), {
    dial: () => {
      const child = new FakeAttachChild()
      children.push(child)
      return child
    },
    // Injected so no test starts a real streamd.
    reviveStreamd: (jobName) => {
      revives.push(jobName)
      return Promise.resolve()
    },
    heartbeatIntervalMs: deps.heartbeatIntervalMs ?? 60_000,
    commandTimeoutMs: deps.commandTimeoutMs ?? 1_000,
    respawnDelayMs: deps.respawnDelayMs ?? 5,
    maxRespawnDelayMs: 20,
    log: () => { /* quiet */ },
  })
  return { watcher, children, revives }
}

/**
 * Drive a watcher through the banner, the `list-panes` reply, the session,
 * status and model subscriptions for each agent window, and the window
 * listing that follows the stream coming up.
 */
async function connectWatcher(
  child: FakeAttachChild,
  paneId = '%7',
  tool = 'claude',
  windows = `0|@0|${tool}`,
): Promise<void> {
  child.feedBanner()
  await vi.waitFor(() => expect(child.commandCount).toBe(1)) // list-panes
  child.feedReply(`${paneId}\t${tool}\t0\t`)
  await vi.waitFor(() => expect(child.commandCount).toBe(2)) // refresh-client -B session
  child.feedReply('')
  await vi.waitFor(() => expect(child.commandCount).toBe(3)) // refresh-client -B status
  child.feedReply('')
  await vi.waitFor(() => expect(child.commandCount).toBe(4)) // refresh-client -B model
  child.feedReply('')
  await vi.waitFor(() => expect(isWorkspaceStreamHealthy('demo', 's1')).toBe(true))
  // list-windows; a short heartbeat may already follow it.
  await vi.waitFor(() => expect(child.commandCount).toBeGreaterThanOrEqual(5))
  child.feedReply(windows)
  await vi.waitFor(() => expect(readWorkspaceTerminals('demo', 's1')).toBeDefined())
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

describe('WorkspaceStatusWatcher (title tools)', () => {
  it('enumerates agent panes, subscribes to their titles, and marks the stream healthy', async () => {
    const { watcher, children } = makeWatcher('claude')
    watchers.push(watcher)
    watcher.start()
    const child = children[0]
    await connectWatcher(child)
    const sent = child.writes.join('')
    expect(sent).toContain("list-panes -s -F '#{pane_id}\t#{window_name}\t#{m/r:^\"?sleep infinity\"?$,#{pane_start_command}}\t#{=1024;s/[^ -~]//:@yaac-session}' -t yaac")
    // Includes the pane id, since same-name subscriptions replace each other.
    expect(sent).toContain("refresh-client -B 'status-7:%7:#{pane_title}'")
    // No status yet reads as waiting.
    expect(readWorkspaceStatus('demo', 's1')).toBe('waiting')
  })

  it('lists the terminals as the stream comes up and on each window event, and keeps them across a drop', async () => {
    const { watcher, children } = makeWatcher('claude')
    watchers.push(watcher)
    watcher.start()
    const child = children[0]
    await connectWatcher(child, '%7', 'claude', '0|@0|claude\n1|@1|init')
    // Every window but the agent's.
    expect(readWorkspaceTerminals('demo', 's1')).toEqual([{ target: 'window:@1', name: 'init' }])
    expect(child.writes.join('')).toContain("list-windows -t yaac -F '#{window_index}|#{window_id}|#{window_name}'")

    // Each event re-lists the windows over the stream, then the driver
    // re-lists its panes.
    const windowEvent = async (line: string, windows: string): Promise<void> => {
      const n = child.commandCount
      child.feed(`${line}\n`)
      await vi.waitFor(() => expect(child.commandCount).toBe(n + 2))
      child.feedReply(windows)
      child.feedReply('%7\tclaude\t0\t')
    }
    await windowEvent('%window-add @2', '0|@0|claude\n1|@1|init\n2|@2|shell')
    await vi.waitFor(() => expect(readWorkspaceTerminals('demo', 's1')).toEqual([
      { target: 'window:@1', name: 'init' },
      { target: 'window:@2', name: 'shell' },
    ]))
    await windowEvent('%window-renamed @2 build', '0|@0|claude\n1|@1|init\n2|@2|build')
    await vi.waitFor(() => expect(readWorkspaceTerminals('demo', 's1')?.[1]?.name).toBe('build'))
    await windowEvent('%window-close @1', '0|@0|claude\n2|@2|build')
    await vi.waitFor(() => expect(readWorkspaceTerminals('demo', 's1')).toEqual([
      { target: 'window:@2', name: 'build' },
    ]))

    // A dropped stream keeps the last listing.
    child.emitExit()
    expect(readWorkspaceTerminals('demo', 's1')).toEqual([{ target: 'window:@2', name: 'build' }])
  })

  it('classifies pushed title values from the subscription', async () => {
    const { watcher, children } = makeWatcher('claude')
    watchers.push(watcher)
    watcher.start()
    const child = children[0]
    await connectWatcher(child)

    child.feed('%subscription-changed status-7 $0 @0 0 %7 : ⠋ working\n')
    expect(readWorkspaceStatus('demo', 's1')).toBe('running')

    child.feed('%subscription-changed status-7 $0 @0 0 %7 : ✳ done\n')
    expect(readWorkspaceStatus('demo', 's1')).toBe('waiting')
  })

  it('ignores subscriptions for other panes or names', async () => {
    const { watcher, children } = makeWatcher('claude')
    watchers.push(watcher)
    watcher.start()
    const child = children[0]
    await connectWatcher(child)

    child.feed('%subscription-changed status-9 $0 @0 0 %9 : ⠋ other pane\n')
    child.feed('%subscription-changed other $0 @0 0 %7 : ⠋ other name\n')
    expect(readWorkspaceStatus('demo', 's1')).toBe('waiting')
  })

  it('keeps status sticky and flips health on stream exit, then respawns', async () => {
    const { watcher, children } = makeWatcher('claude', { respawnDelayMs: 5 })
    watchers.push(watcher)
    watcher.start()
    const child = children[0]
    await connectWatcher(child)
    child.feed('%subscription-changed status-7 $0 @0 0 %7 : ⠋ working\n')
    expect(readWorkspaceStatus('demo', 's1')).toBe('running')

    child.emitExit()
    expect(isWorkspaceStreamHealthy('demo', 's1')).toBe(false)
    expect(readWorkspaceStatus('demo', 's1')).toBe('running') // sticky

    await vi.waitFor(() => expect(children.length).toBe(2))
    const second = children[1]
    second.feedBanner()
    await vi.waitFor(() => expect(second.commandCount).toBe(1))
    second.feedReply('%7\tclaude\t0\t')
    for (const n of [2, 3, 4]) {
      await vi.waitFor(() => expect(second.commandCount).toBe(n))
      second.feedReply('')
    }
    await vi.waitFor(() => expect(isWorkspaceStreamHealthy('demo', 's1')).toBe(true))
  })

  it('tears down and respawns when the heartbeat gets no reply', async () => {
    // Long enough for init replies (~50ms apart), short for the heartbeat.
    const { watcher, children } = makeWatcher('claude', {
      heartbeatIntervalMs: 10,
      commandTimeoutMs: 250,
      respawnDelayMs: 5,
    })
    watchers.push(watcher)
    watcher.start()
    const child = children[0]
    await connectWatcher(child)
    // The unanswered heartbeat times out and the watcher respawns.
    await vi.waitFor(() => expect(children.length).toBeGreaterThanOrEqual(2))
    expect(child.killed).toBe(true)
    expect(isWorkspaceStreamHealthy('demo', 's1')).toBe(false)
  })

  it('answers heartbeats to stay connected', async () => {
    const { watcher, children } = makeWatcher('claude', {
      heartbeatIntervalMs: 15,
      commandTimeoutMs: 200,
    })
    watchers.push(watcher)
    watcher.start()
    const child = children[0]
    await connectWatcher(child)
    await vi.waitFor(() => expect(child.commandCount).toBeGreaterThanOrEqual(6)) // heartbeat sent
    child.feedReply('ok')
    await new Promise((r) => setTimeout(r, 30))
    expect(children.length).toBe(1)
    expect(isWorkspaceStreamHealthy('demo', 's1')).toBe(true)
  })

  it('respawns when init fails (tmux window not up yet)', async () => {
    const { watcher, children } = makeWatcher('claude', { respawnDelayMs: 5 })
    watchers.push(watcher)
    watcher.start()
    const child = children[0]
    child.feedBanner()
    await vi.waitFor(() => expect(child.commandCount).toBe(1))
    child.feed('%begin 1 101 1\ncan\'t find window\n%error 1 101 1\n')
    await vi.waitFor(() => expect(children.length).toBe(2))
  })

  it('re-execs streamd (self-heal) every third consecutive stream failure', async () => {
    const { watcher, children, revives } = makeWatcher('claude', { respawnDelayMs: 1 })
    watchers.push(watcher)
    watcher.start()
    for (let i = 1; i <= 3; i++) {
      await vi.waitFor(() => expect(children.length).toBe(i))
      children[i - 1].emitExit()
    }
    await vi.waitFor(() => expect(revives).toEqual(['yaac-demo-s1']))
    // A successful connect resets the counter.
    await vi.waitFor(() => expect(children.length).toBe(4))
    await connectWatcher(children[3])
    expect(revives).toHaveLength(1)
  })

  it('stop() kills the child, prevents respawn, and discards chat messages parked for a reconnect', async () => {
    const { watcher, children } = makeWatcher('claude', { respawnDelayMs: 1 })
    watchers.push(watcher)
    watcher.start()
    const child = children[0]
    await connectWatcher(child)
    // A chat's queue parked by a dropped connection would otherwise be sent
    // when the workspace is next resumed.
    const reject = vi.fn()
    const turn: QueuedTurn = { id: 'q1', text: 'stale', images: 0, blocks: [], resolve: () => {}, reject }
    parkAcpQueue('demo', 's1', 'acp-1', [turn])
    watcher.stop()
    expect(child.killed).toBe(true)
    expect(reject).toHaveBeenCalled()
    expect(takeAcpQueue('demo', 's1', 'acp-1')).toEqual([])
    child.emitExit()
    await new Promise((r) => setTimeout(r, 20))
    expect(children.length).toBe(1)
  })
})

describe('WorkspaceStatusWatcher (pane tools)', () => {
  it('subscribes opencode to its tmux-side busy format (no capture-pane, no %output)', async () => {
    const { watcher, children } = makeWatcher('opencode')
    watchers.push(watcher)
    watcher.start()
    const child = children[0]
    await connectWatcher(child, '%2', 'opencode')
    const sent = child.writes.join('')
    expect(sent).toContain("list-panes -s -F '#{pane_id}\t#{window_name}\t#{m/r:^\"?sleep infinity\"?$,#{pane_start_command}}\t#{=1024;s/[^ -~]//:@yaac-session}' -t yaac")
    // tmux itself searches the pane content; nothing is captured.
    expect(sent).toContain("refresh-client -B 'status-2:%2:#{?#{||:#{C/ri:")
    expect(sent).not.toContain('capture-pane')
  })

  it('records the verdict pushed by the tmux-side subscription', async () => {
    const { watcher, children } = makeWatcher('pi')
    watchers.push(watcher)
    watcher.start()
    const child = children[0]
    await connectWatcher(child, '%2', 'pi')

    // opencode/pi report the status word directly.
    child.feed('%subscription-changed status-2 $0 @0 0 %2 : running\n')
    expect(readWorkspaceStatus('demo', 's1')).toBe('running')
    child.feed('%subscription-changed status-2 $0 @0 0 %2 : waiting\n')
    expect(readWorkspaceStatus('demo', 's1')).toBe('waiting')
  })

  it('ignores stray %output (the watcher attaches no-output, so it never re-captures)', async () => {
    const { watcher, children } = makeWatcher('opencode')
    watchers.push(watcher)
    watcher.start()
    const child = children[0]
    await connectWatcher(child, '%2', 'opencode')
    child.feed('%output %2 leftover redraw bytes\n')
    await new Promise((r) => setTimeout(r, 25))
    expect(child.commandCount).toBe(5) // no capture-pane issued
  })
})

function workspace(opts: {
  workspaceId: string
  projectId?: string
  running?: boolean
  prewarmed?: boolean
  tool?: AgentTool
  mode?: AgentMode
}): RuntimeHandle {
  const projectId = opts.projectId ?? 'demo'
  return handleFixture({
    workspaceId: opts.workspaceId,
    projectId: projectId,
    jobName: `yaac-${projectId}-${opts.workspaceId}`,
    tool: opts.tool ?? 'claude',
    running: opts.running !== false,
    state: opts.running === false ? 'pending' : 'running',
    prewarmed: opts.prewarmed ?? false,
    ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
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

  // An acp spare is watched so its handshake runs before a claim needs it.
  it('starts a watcher per running workspace, and per acp spare', () => {
    const { manager, children } = makeManager()
    try {
      manager.sync([
        workspace({ workspaceId: 's1' }),
        workspace({ workspaceId: 's2', running: false }),
        workspace({ workspaceId: 's3', prewarmed: true }),
        workspace({ workspaceId: 's4', prewarmed: true, mode: 'acp' }),
      ])
      expect(manager.size).toBe(2)
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
      expect(children).toHaveLength(1)
    } finally {
      manager.stopAll()
    }
  })

  it('stops the watcher and evicts the store entry when the pod goes away', () => {
    const { manager, children } = makeManager()
    try {
      manager.sync([workspace({ workspaceId: 's1' })])
      setAgentStatus('demo', 's1', '%0', 'running')
      setWorkspaceTerminals('demo', 's1', [{ target: 'window:@1', name: 'shell' }])
      manager.sync([])
      expect(manager.size).toBe(0)
      expect(children[0].killed).toBe(true)
      expect(readWorkspaceStatus('demo', 's1')).toBe('waiting')
      expect(readWorkspaceTerminals('demo', 's1')).toBeUndefined()
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

  // Its conversation is the one the claim hands over, so it stays connected.
  it("keeps an acp spare's watcher across its claim", () => {
    const { manager, children } = makeManager()
    try {
      manager.sync([workspace({ workspaceId: 's1', prewarmed: true, mode: 'acp' })])
      manager.sync([workspace({ workspaceId: 's1', mode: 'acp', tool: 'codex' })])
      expect(manager.size).toBe(1)
      expect(children).toHaveLength(1)
      expect(children[0].killed).toBe(false)
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
