import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  WorktreeStatusWatcher,
  StatusWatcherManager,
  type WatchedWorktree,
} from '#runtime/status/status-watcher'
import type { RuntimeHandle, StreamChild } from '#drivers/contract'
import { handleFixture } from '@yaac/test-utils/fake-driver'
import type { AgentTool } from '@yaac/shared/types'
import {
  readWorktreeStatus,
  isWorktreeStreamHealthy,
  setAgentStatus,
  _resetWorktreeStatusStoreForTests,
} from '#runtime/status/status-store'
import {
  worktreeControlStreamSend,
  _clearControlStreamRegistryForTests,
} from '#runtime/status/control-stream-registry'

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

function session(tool: WatchedWorktree['tool']): WatchedWorktree {
  return { slug: 'demo', worktreeId: 's1', jobName: 'yaac-demo-s1', tool, mode: 'tui' }
}

function makeWatcher(tool: WatchedWorktree['tool'], deps: {
  heartbeatIntervalMs?: number
  commandTimeoutMs?: number
  respawnDelayMs?: number
} = {}): { watcher: WorktreeStatusWatcher; children: FakeAttachChild[]; revives: string[] } {
  const children: FakeAttachChild[] = []
  const revives: string[] = []
  const watcher = new WorktreeStatusWatcher(session(tool), {
    dial: () => {
      const child = new FakeAttachChild()
      children.push(child)
      return child
    },
    // Injected so no test ever reaches the real kubectl-exec streamd boot.
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
 * Drive a watcher through banner + pane enumeration + status-format subscribe.
 * The watcher lists the yaac session's panes and subscribes each agent window
 * it finds, so the reply here is a `list-panes` table, not a single pane id.
 */
async function connectWatcher(
  child: FakeAttachChild,
  paneId = '%7',
  tool = 'claude',
): Promise<void> {
  child.feedBanner()
  await vi.waitFor(() => expect(child.commandCount).toBe(1)) // list-panes
  child.feedReply(`${paneId} ${tool}`)
  await vi.waitFor(() => expect(child.commandCount).toBe(2)) // refresh-client -B
  child.feedReply('')
  await vi.waitFor(() => expect(isWorktreeStreamHealthy('demo', 's1')).toBe(true))
}

let watchers: WorktreeStatusWatcher[] = []

beforeEach(() => {
  _resetWorktreeStatusStoreForTests()
  _clearControlStreamRegistryForTests()
})

afterEach(() => {
  for (const w of watchers) w.stop()
  watchers = []
})

describe('WorktreeStatusWatcher (title tools)', () => {
  it('enumerates agent panes, subscribes to their titles, and marks the stream healthy', async () => {
    const { watcher, children } = makeWatcher('claude')
    watchers.push(watcher)
    watcher.start()
    const child = children[0]
    await connectWatcher(child)
    const sent = child.writes.join('')
    expect(sent).toContain("list-panes -s -F '#{pane_id} #{window_name}' -t yaac")
    // The subscription name carries the pane id: same-name subscriptions
    // replace each other, so a shared name silences every pane but the last.
    expect(sent).toContain("refresh-client -B 'status-7:%7:#{pane_title}'")
    // No classification yet — absent entry reads as waiting.
    expect(readWorktreeStatus('demo', 's1')).toBe('waiting')
  })

  it('publishes the proven stream as the session command channel and retires it with the stream', async () => {
    const { watcher, children } = makeWatcher('claude')
    watchers.push(watcher)
    watcher.start()
    const child = children[0]
    // Not registered while still attaching (registration happens only
    // after the pane-id and subscribe replies prove the stream).
    expect(worktreeControlStreamSend('yaac-demo-s1')).toBeUndefined()
    await connectWatcher(child)
    const send = worktreeControlStreamSend('yaac-demo-s1')
    expect(send).toBeDefined()

    // A command through the channel rides the same control-mode stream.
    const reply = send!('list-windows -t yaac')
    await vi.waitFor(() => expect(child.commandCount).toBe(3))
    expect(child.writes.join('')).toContain('list-windows -t yaac')
    child.feedReply('0|@0|claude')
    await expect(reply).resolves.toBe('0|@0|claude')

    // Stream death unregisters the channel (until the respawn re-proves one).
    child.emitExit()
    expect(worktreeControlStreamSend('yaac-demo-s1')).toBeUndefined()
  })

  it('classifies pushed title values from the subscription', async () => {
    const { watcher, children } = makeWatcher('claude')
    watchers.push(watcher)
    watcher.start()
    const child = children[0]
    await connectWatcher(child)

    child.feed('%subscription-changed status-7 $0 @0 0 %7 : ⠋ working\n')
    expect(readWorktreeStatus('demo', 's1')).toBe('running')

    child.feed('%subscription-changed status-7 $0 @0 0 %7 : ✳ done\n')
    expect(readWorktreeStatus('demo', 's1')).toBe('waiting')
  })

  it('ignores subscriptions for other panes or names', async () => {
    const { watcher, children } = makeWatcher('claude')
    watchers.push(watcher)
    watcher.start()
    const child = children[0]
    await connectWatcher(child)

    child.feed('%subscription-changed status-9 $0 @0 0 %9 : ⠋ other pane\n')
    child.feed('%subscription-changed other $0 @0 0 %7 : ⠋ other name\n')
    expect(readWorktreeStatus('demo', 's1')).toBe('waiting')
  })

  it('keeps status sticky and flips health on stream exit, then respawns', async () => {
    const { watcher, children } = makeWatcher('claude', { respawnDelayMs: 5 })
    watchers.push(watcher)
    watcher.start()
    const child = children[0]
    await connectWatcher(child)
    child.feed('%subscription-changed status-7 $0 @0 0 %7 : ⠋ working\n')
    expect(readWorktreeStatus('demo', 's1')).toBe('running')

    child.emitExit()
    expect(isWorktreeStreamHealthy('demo', 's1')).toBe(false)
    expect(readWorktreeStatus('demo', 's1')).toBe('running') // sticky

    await vi.waitFor(() => expect(children.length).toBe(2))
    const second = children[1]
    second.feedBanner()
    await vi.waitFor(() => expect(second.commandCount).toBe(1))
    second.feedReply('%7 claude')
    await vi.waitFor(() => expect(second.commandCount).toBe(2))
    second.feedReply('')
    await vi.waitFor(() => expect(isWorktreeStreamHealthy('demo', 's1')).toBe(true))
  })

  it('tears down and respawns when the heartbeat gets no reply', async () => {
    // commandTimeoutMs must outlast the test's own waitFor polling
    // during init (replies are fed ~50ms apart) while still expiring
    // the unanswered heartbeat quickly.
    const { watcher, children } = makeWatcher('claude', {
      heartbeatIntervalMs: 10,
      commandTimeoutMs: 250,
      respawnDelayMs: 5,
    })
    watchers.push(watcher)
    watcher.start()
    const child = children[0]
    await connectWatcher(child)
    // Heartbeat fires but we never feed a reply → timeout → respawn.
    // Later generations keep timing out during init (nothing answers
    // them either), so the child count only grows from here.
    await vi.waitFor(() => expect(children.length).toBeGreaterThanOrEqual(2))
    expect(child.killed).toBe(true)
    expect(isWorktreeStreamHealthy('demo', 's1')).toBe(false)
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
    await vi.waitFor(() => expect(child.commandCount).toBe(3)) // heartbeat sent
    child.feedReply('ok')
    await new Promise((r) => setTimeout(r, 30))
    expect(children.length).toBe(1)
    expect(isWorktreeStreamHealthy('demo', 's1')).toBe(true)
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
    // Three consecutive failed streams (each child dies before connecting).
    for (let i = 1; i <= 3; i++) {
      await vi.waitFor(() => expect(children.length).toBe(i))
      children[i - 1].emitExit()
    }
    await vi.waitFor(() => expect(revives).toEqual(['yaac-demo-s1']))
    // A successful connect resets the counter — no further revive fires.
    await vi.waitFor(() => expect(children.length).toBe(4))
    await connectWatcher(children[3])
    expect(revives).toHaveLength(1)
  })

  it('stop() kills the child and prevents respawn', async () => {
    const { watcher, children } = makeWatcher('claude', { respawnDelayMs: 1 })
    watchers.push(watcher)
    watcher.start()
    const child = children[0]
    await connectWatcher(child)
    watcher.stop()
    expect(child.killed).toBe(true)
    child.emitExit()
    await new Promise((r) => setTimeout(r, 20))
    expect(children.length).toBe(1)
  })
})

describe('WorktreeStatusWatcher (pane tools)', () => {
  it('subscribes opencode to its tmux-side busy format (no capture-pane, no %output)', async () => {
    const { watcher, children } = makeWatcher('opencode')
    watchers.push(watcher)
    watcher.start()
    const child = children[0]
    await connectWatcher(child, '%2', 'opencode')
    const sent = child.writes.join('')
    expect(sent).toContain("list-panes -s -F '#{pane_id} #{window_name}' -t yaac")
    // The subscription carries a content-search format that resolves the
    // verdict inside tmux; the pane is never captured.
    expect(sent).toContain("refresh-client -B 'status-2:%2:#{?#{||:#{C/ri:")
    expect(sent).not.toContain('capture-pane')
  })

  it('records the verdict pushed by the tmux-side subscription', async () => {
    const { watcher, children } = makeWatcher('pi')
    watchers.push(watcher)
    watcher.start()
    const child = children[0]
    await connectWatcher(child, '%2', 'pi')

    // opencode/pi push an already-resolved word, not pane content.
    child.feed('%subscription-changed status-2 $0 @0 0 %2 : running\n')
    expect(readWorktreeStatus('demo', 's1')).toBe('running')
    child.feed('%subscription-changed status-2 $0 @0 0 %2 : waiting\n')
    expect(readWorktreeStatus('demo', 's1')).toBe('waiting')
  })

  it('ignores stray %output (the watcher attaches no-output, so it never re-captures)', async () => {
    const { watcher, children } = makeWatcher('opencode')
    watchers.push(watcher)
    watcher.start()
    const child = children[0]
    await connectWatcher(child, '%2', 'opencode')
    child.feed('%output %2 leftover redraw bytes\n')
    await new Promise((r) => setTimeout(r, 25))
    expect(child.commandCount).toBe(2) // no capture-pane issued
  })
})

function workspace(opts: {
  worktreeId: string
  slug?: string
  running?: boolean
  prewarmed?: boolean
  tool?: AgentTool
}): RuntimeHandle {
  const slug = opts.slug ?? 'demo'
  return handleFixture({
    workspaceId: opts.worktreeId,
    projectSlug: slug,
    jobName: `yaac-${slug}-${opts.worktreeId}`,
    tool: opts.tool ?? 'claude',
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

  it('starts a watcher per running non-prewarmed session pod', () => {
    const { manager, children } = makeManager()
    try {
      manager.sync([
        workspace({ worktreeId: 's1' }),
        workspace({ worktreeId: 's2', running: false }),
        workspace({ worktreeId: 's3', prewarmed: true }),
      ])
      expect(manager.size).toBe(1)
      expect(children).toHaveLength(1)
    } finally {
      manager.stopAll()
    }
  })

  it('is idempotent for an unchanged pod set', () => {
    const { manager, children } = makeManager()
    try {
      manager.sync([workspace({ worktreeId: 's1' })])
      manager.sync([workspace({ worktreeId: 's1' })])
      expect(manager.size).toBe(1)
      expect(children).toHaveLength(1)
    } finally {
      manager.stopAll()
    }
  })

  it('stops the watcher and evicts the store entry when the pod goes away', () => {
    const { manager, children } = makeManager()
    try {
      manager.sync([workspace({ worktreeId: 's1' })])
      setAgentStatus('demo', 's1', '%0', 'running')
      manager.sync([])
      expect(manager.size).toBe(0)
      expect(children[0].killed).toBe(true)
      expect(readWorktreeStatus('demo', 's1')).toBe('waiting')
    } finally {
      manager.stopAll()
    }
  })

  it('starts a watcher when a claimed spare loses its prewarm label', () => {
    const { manager } = makeManager()
    try {
      manager.sync([workspace({ worktreeId: 's1', prewarmed: true })])
      expect(manager.size).toBe(0)
      manager.sync([workspace({ worktreeId: 's1' })])
      expect(manager.size).toBe(1)
    } finally {
      manager.stopAll()
    }
  })

  it('stopAll kills every watcher', () => {
    const { manager, children } = makeManager()
    manager.sync([workspace({ worktreeId: 's1' }), workspace({ worktreeId: 's2' })])
    expect(manager.size).toBe(2)
    manager.stopAll()
    expect(manager.size).toBe(0)
    expect(children.every((c) => c.killed)).toBe(true)
  })
})
