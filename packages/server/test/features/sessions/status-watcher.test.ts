import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  SessionStatusWatcher,
  StatusWatcherManager,
  attachClientFlags,
  busyStatusFormat,
  classifyAgentObservation,
  type AttachChild,
  type WatchedSession,
} from '#features/sessions/status-watcher'
import {
  readSessionStatus,
  isSessionStreamHealthy,
  setSessionStatus,
  _resetSessionStatusStoreForTests,
} from '#features/sessions/status-store'
import {
  sessionControlStreamSend,
  _clearControlStreamRegistryForTests,
} from '#features/sessions/control-stream-registry'
import { JOB_NAME_LABEL, LABEL_PREWARMED, LABEL_PROJECT, LABEL_SESSION_ID, LABEL_TOOL, type SessionPod } from '#platform/k8s/pods'

class FakeAttachChild implements AttachChild {
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

function session(tool: WatchedSession['tool']): WatchedSession {
  return { slug: 'demo', sessionId: 's1', jobName: 'yaac-demo-s1', tool }
}

function makeWatcher(tool: WatchedSession['tool'], deps: {
  heartbeatIntervalMs?: number
  commandTimeoutMs?: number
  respawnDelayMs?: number
} = {}): { watcher: SessionStatusWatcher; children: FakeAttachChild[]; revives: string[] } {
  const children: FakeAttachChild[] = []
  const revives: string[] = []
  const watcher = new SessionStatusWatcher(session(tool), {
    spawnAttach: () => {
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

/** Drive a watcher through banner + pane-id + status-format subscribe. */
async function connectWatcher(child: FakeAttachChild, paneId = '%7'): Promise<void> {
  child.feedBanner()
  await vi.waitFor(() => expect(child.commandCount).toBe(1)) // display-message pane-id
  child.feedReply(paneId)
  await vi.waitFor(() => expect(child.commandCount).toBe(2)) // refresh-client -B
  child.feedReply('')
  await vi.waitFor(() => expect(isSessionStreamHealthy('demo', 's1')).toBe(true))
}

let watchers: SessionStatusWatcher[] = []

beforeEach(() => {
  _resetSessionStatusStoreForTests()
  _clearControlStreamRegistryForTests()
})

afterEach(() => {
  for (const w of watchers) w.stop()
  watchers = []
})

describe('attachClientFlags', () => {
  it('attaches every watcher with no-output so agent TUI redraws never cross the exec stream', () => {
    // No tool's status is read from raw pane output any more — claude/codex
    // ride the title subscription, opencode/pi a tmux-side content search —
    // so the client never needs %output.
    const flags = attachClientFlags().split(',')
    expect(flags).toContain('no-output')
    expect(flags).toContain('read-only')
    expect(flags).toContain('ignore-size')
  })
})

describe('busyStatusFormat', () => {
  it('ORs each marker into a case-insensitive content search that resolves running/waiting', () => {
    expect(busyStatusFormat(['esc\\s+interrupt', '[■⬝][■⬝][■⬝][■⬝]'])).toBe(
      '#{?#{||:#{C/ri:esc\\s+interrupt},#{C/ri:[■⬝][■⬝][■⬝][■⬝]}},running,waiting}',
    )
  })

  it('degenerates to a single probe for one marker', () => {
    expect(busyStatusFormat(['working'])).toBe('#{?#{C/ri:working},running,waiting}')
  })
})

describe('classifyAgentObservation', () => {
  it('classifies claude/codex titles by the Braille-spinner prefix', () => {
    expect(classifyAgentObservation('claude', '⠋ Fixing the bug')).toBe('running')
    expect(classifyAgentObservation('claude', '✳ idle prompt')).toBe('waiting')
    expect(classifyAgentObservation('codex', '⠙ project')).toBe('running')
    expect(classifyAgentObservation('codex', '[ ! ] Action Required project')).toBe('waiting')
  })

  it('passes through opencode/pi verdicts already resolved tmux-side', () => {
    // The subscription format yields the word directly; the watcher only
    // trims and maps it (never re-classifies pane content).
    expect(classifyAgentObservation('opencode', 'running')).toBe('running')
    expect(classifyAgentObservation('opencode', 'waiting')).toBe('waiting')
    expect(classifyAgentObservation('pi', ' running ')).toBe('running')
    expect(classifyAgentObservation('pi', 'waiting')).toBe('waiting')
  })
})

describe('SessionStatusWatcher (title tools)', () => {
  it('resolves the agent pane, subscribes to its title, and marks the stream healthy', async () => {
    const { watcher, children } = makeWatcher('claude')
    watchers.push(watcher)
    watcher.start()
    const child = children[0]
    await connectWatcher(child)
    const sent = child.writes.join('')
    expect(sent).toContain("display-message -p -t yaac:claude.0 '#{pane_id}'")
    expect(sent).toContain("refresh-client -B 'status:%7:#{pane_title}'")
    // No classification yet — absent entry reads as waiting.
    expect(readSessionStatus('demo', 's1')).toBe('waiting')
  })

  it('publishes the proven stream as the session command channel and retires it with the stream', async () => {
    const { watcher, children } = makeWatcher('claude')
    watchers.push(watcher)
    watcher.start()
    const child = children[0]
    // Not registered while still attaching (registration happens only
    // after the pane-id and subscribe replies prove the stream).
    expect(sessionControlStreamSend('yaac-demo-s1')).toBeUndefined()
    await connectWatcher(child)
    const send = sessionControlStreamSend('yaac-demo-s1')
    expect(send).toBeDefined()

    // A command through the channel rides the same control-mode stream.
    const reply = send!('list-windows -t yaac')
    await vi.waitFor(() => expect(child.commandCount).toBe(3))
    expect(child.writes.join('')).toContain('list-windows -t yaac')
    child.feedReply('0|@0|claude')
    await expect(reply).resolves.toBe('0|@0|claude')

    // Stream death unregisters the channel (until the respawn re-proves one).
    child.emitExit()
    expect(sessionControlStreamSend('yaac-demo-s1')).toBeUndefined()
  })

  it('classifies pushed title values from the subscription', async () => {
    const { watcher, children } = makeWatcher('claude')
    watchers.push(watcher)
    watcher.start()
    const child = children[0]
    await connectWatcher(child)

    child.feed('%subscription-changed status $0 @0 0 %7 : ⠋ working\n')
    expect(readSessionStatus('demo', 's1')).toBe('running')

    child.feed('%subscription-changed status $0 @0 0 %7 : ✳ done\n')
    expect(readSessionStatus('demo', 's1')).toBe('waiting')
  })

  it('ignores subscriptions for other panes or names', async () => {
    const { watcher, children } = makeWatcher('claude')
    watchers.push(watcher)
    watcher.start()
    const child = children[0]
    await connectWatcher(child)

    child.feed('%subscription-changed status $0 @0 0 %9 : ⠋ other pane\n')
    child.feed('%subscription-changed other $0 @0 0 %7 : ⠋ other name\n')
    expect(readSessionStatus('demo', 's1')).toBe('waiting')
  })

  it('keeps status sticky and flips health on stream exit, then respawns', async () => {
    const { watcher, children } = makeWatcher('claude', { respawnDelayMs: 5 })
    watchers.push(watcher)
    watcher.start()
    const child = children[0]
    await connectWatcher(child)
    child.feed('%subscription-changed status $0 @0 0 %7 : ⠋ working\n')
    expect(readSessionStatus('demo', 's1')).toBe('running')

    child.emitExit()
    expect(isSessionStreamHealthy('demo', 's1')).toBe(false)
    expect(readSessionStatus('demo', 's1')).toBe('running') // sticky

    await vi.waitFor(() => expect(children.length).toBe(2))
    const second = children[1]
    second.feedBanner()
    await vi.waitFor(() => expect(second.commandCount).toBe(1))
    second.feedReply('%7')
    await vi.waitFor(() => expect(second.commandCount).toBe(2))
    second.feedReply('')
    await vi.waitFor(() => expect(isSessionStreamHealthy('demo', 's1')).toBe(true))
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
    expect(isSessionStreamHealthy('demo', 's1')).toBe(false)
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
    expect(isSessionStreamHealthy('demo', 's1')).toBe(true)
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

describe('SessionStatusWatcher (pane tools)', () => {
  it('subscribes opencode to its tmux-side busy format (no capture-pane, no %output)', async () => {
    const { watcher, children } = makeWatcher('opencode')
    watchers.push(watcher)
    watcher.start()
    const child = children[0]
    await connectWatcher(child, '%2')
    const sent = child.writes.join('')
    expect(sent).toContain("display-message -p -t yaac:opencode.0 '#{pane_id}'")
    // The subscription carries a content-search format that resolves the
    // verdict inside tmux; the pane is never captured.
    expect(sent).toContain("refresh-client -B 'status:%2:#{?#{||:#{C/ri:")
    expect(sent).not.toContain('capture-pane')
  })

  it('records the verdict pushed by the tmux-side subscription', async () => {
    const { watcher, children } = makeWatcher('pi')
    watchers.push(watcher)
    watcher.start()
    const child = children[0]
    await connectWatcher(child, '%2')

    // opencode/pi push an already-resolved word, not pane content.
    child.feed('%subscription-changed status $0 @0 0 %2 : running\n')
    expect(readSessionStatus('demo', 's1')).toBe('running')
    child.feed('%subscription-changed status $0 @0 0 %2 : waiting\n')
    expect(readSessionStatus('demo', 's1')).toBe('waiting')
  })

  it('ignores stray %output (the watcher attaches no-output, so it never re-captures)', async () => {
    const { watcher, children } = makeWatcher('opencode')
    watchers.push(watcher)
    watcher.start()
    const child = children[0]
    await connectWatcher(child, '%2')
    child.feed('%output %2 leftover redraw bytes\n')
    await new Promise((r) => setTimeout(r, 25))
    expect(child.commandCount).toBe(2) // no capture-pane issued
  })
})

function pod(opts: {
  sessionId: string
  slug?: string
  running?: boolean
  prewarmed?: boolean
  tool?: string
}): SessionPod {
  const slug = opts.slug ?? 'demo'
  return {
    jobName: `yaac-${slug}-${opts.sessionId}`,
    podName: `yaac-${slug}-${opts.sessionId}-abcde`,
    sessionId: opts.sessionId,
    projectSlug: slug,
    tool: opts.tool ?? 'claude',
    phase: opts.running === false ? 'Pending' : 'Running',
    running: opts.running !== false,
    terminating: false,
    createdAtMs: 0,
    labels: {
      [JOB_NAME_LABEL]: `yaac-${slug}-${opts.sessionId}`,
      [LABEL_SESSION_ID]: opts.sessionId,
      [LABEL_PROJECT]: slug,
      [LABEL_TOOL]: opts.tool ?? 'claude',
      ...(opts.prewarmed ? { [LABEL_PREWARMED]: 'true' } : {}),
    },
  }
}

describe('StatusWatcherManager', () => {
  function makeManager(): { manager: StatusWatcherManager; children: FakeAttachChild[] } {
    const children: FakeAttachChild[] = []
    const manager = new StatusWatcherManager({
      spawnAttach: () => {
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
        pod({ sessionId: 's1' }),
        pod({ sessionId: 's2', running: false }),
        pod({ sessionId: 's3', prewarmed: true }),
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
      manager.sync([pod({ sessionId: 's1' })])
      manager.sync([pod({ sessionId: 's1' })])
      expect(manager.size).toBe(1)
      expect(children).toHaveLength(1)
    } finally {
      manager.stopAll()
    }
  })

  it('stops the watcher and evicts the store entry when the pod goes away', () => {
    const { manager, children } = makeManager()
    try {
      manager.sync([pod({ sessionId: 's1' })])
      setSessionStatus('demo', 's1', 'running')
      manager.sync([])
      expect(manager.size).toBe(0)
      expect(children[0].killed).toBe(true)
      expect(readSessionStatus('demo', 's1')).toBe('waiting')
    } finally {
      manager.stopAll()
    }
  })

  it('starts a watcher when a claimed spare loses its prewarm label', () => {
    const { manager } = makeManager()
    try {
      manager.sync([pod({ sessionId: 's1', prewarmed: true })])
      expect(manager.size).toBe(0)
      manager.sync([pod({ sessionId: 's1' })])
      expect(manager.size).toBe(1)
    } finally {
      manager.stopAll()
    }
  })

  it('stopAll kills every watcher', () => {
    const { manager, children } = makeManager()
    manager.sync([pod({ sessionId: 's1' }), pod({ sessionId: 's2' })])
    expect(manager.size).toBe(2)
    manager.stopAll()
    expect(manager.size).toBe(0)
    expect(children.every((c) => c.killed)).toBe(true)
  })
})
