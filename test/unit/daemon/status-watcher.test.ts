import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  SessionStatusWatcher,
  StatusWatcherManager,
  classifyAgentObservation,
  type AttachChild,
  type WatchedSession,
} from '@/daemon/status-watcher'
import {
  readSessionStatus,
  isSessionStreamHealthy,
  setSessionStatus,
  _resetSessionStatusStoreForTests,
} from '@/lib/session/status-store'
import { JOB_NAME_LABEL, LABEL_PREWARMED, LABEL_PROJECT, LABEL_SESSION_ID, LABEL_TOOL, type SessionPod } from '@/lib/k8s/pods'

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
  captureDebounceMs?: number
  respawnDelayMs?: number
} = {}): { watcher: SessionStatusWatcher; children: FakeAttachChild[] } {
  const children: FakeAttachChild[] = []
  const watcher = new SessionStatusWatcher(session(tool), {
    spawnAttach: () => {
      const child = new FakeAttachChild()
      children.push(child)
      return child
    },
    heartbeatIntervalMs: deps.heartbeatIntervalMs ?? 60_000,
    commandTimeoutMs: deps.commandTimeoutMs ?? 1_000,
    captureDebounceMs: deps.captureDebounceMs ?? 5,
    respawnDelayMs: deps.respawnDelayMs ?? 5,
    maxRespawnDelayMs: 20,
    log: () => { /* quiet */ },
  })
  return { watcher, children }
}

/** Drive a claude/codex watcher through banner + pane-id + subscribe. */
async function connectTitleWatcher(child: FakeAttachChild): Promise<void> {
  child.feedBanner()
  await vi.waitFor(() => expect(child.commandCount).toBe(1)) // display-message pane-id
  child.feedReply('%7')
  await vi.waitFor(() => expect(child.commandCount).toBe(2)) // refresh-client -B
  child.feedReply('')
  await vi.waitFor(() => expect(isSessionStreamHealthy('demo', 's1')).toBe(true))
}

let watchers: SessionStatusWatcher[] = []

beforeEach(() => {
  _resetSessionStatusStoreForTests()
})

afterEach(() => {
  for (const w of watchers) w.stop()
  watchers = []
})

describe('classifyAgentObservation', () => {
  it('classifies claude/codex titles by the Braille-spinner prefix', () => {
    expect(classifyAgentObservation('claude', '⠋ Fixing the bug')).toBe('running')
    expect(classifyAgentObservation('claude', '✳ idle prompt')).toBe('waiting')
    expect(classifyAgentObservation('codex', '⠙ project')).toBe('running')
    expect(classifyAgentObservation('codex', '[ ! ] Action Required project')).toBe('waiting')
  })

  it('classifies opencode pane content by busy markers', () => {
    expect(classifyAgentObservation('opencode', 'stuff\n■■■■■⬝⬝⬝  esc interrupt\n')).toBe('running')
    expect(classifyAgentObservation('opencode', 'a quiet prompt')).toBe('waiting')
  })
})

describe('SessionStatusWatcher (title tools)', () => {
  it('resolves the agent pane, subscribes to its title, and marks the stream healthy', async () => {
    const { watcher, children } = makeWatcher('claude')
    watchers.push(watcher)
    watcher.start()
    const child = children[0]
    await connectTitleWatcher(child)
    const sent = child.writes.join('')
    expect(sent).toContain("display-message -p -t yaac:claude.0 '#{pane_id}'")
    expect(sent).toContain('refresh-client -B "status:%7:#{pane_title}"')
    // No classification yet — absent entry reads as waiting.
    expect(readSessionStatus('demo', 's1')).toBe('waiting')
  })

  it('classifies pushed title values from the subscription', async () => {
    const { watcher, children } = makeWatcher('claude')
    watchers.push(watcher)
    watcher.start()
    const child = children[0]
    await connectTitleWatcher(child)

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
    await connectTitleWatcher(child)

    child.feed('%subscription-changed status $0 @0 0 %9 : ⠋ other pane\n')
    child.feed('%subscription-changed other $0 @0 0 %7 : ⠋ other name\n')
    expect(readSessionStatus('demo', 's1')).toBe('waiting')
  })

  it('keeps status sticky and flips health on stream exit, then respawns', async () => {
    const { watcher, children } = makeWatcher('claude', { respawnDelayMs: 5 })
    watchers.push(watcher)
    watcher.start()
    const child = children[0]
    await connectTitleWatcher(child)
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
    await connectTitleWatcher(child)
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
    await connectTitleWatcher(child)
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

  it('stop() kills the child and prevents respawn', async () => {
    const { watcher, children } = makeWatcher('claude', { respawnDelayMs: 1 })
    watchers.push(watcher)
    watcher.start()
    const child = children[0]
    await connectTitleWatcher(child)
    watcher.stop()
    expect(child.killed).toBe(true)
    child.emitExit()
    await new Promise((r) => setTimeout(r, 20))
    expect(children.length).toBe(1)
  })
})

describe('SessionStatusWatcher (opencode)', () => {
  async function connectOpencode(child: FakeAttachChild, initialPane: string): Promise<void> {
    child.feedBanner()
    await vi.waitFor(() => expect(child.commandCount).toBe(1)) // pane id
    child.feedReply('%2')
    await vi.waitFor(() => expect(child.commandCount).toBe(2)) // initial capture
    child.feedReply(initialPane)
    await vi.waitFor(() => expect(isSessionStreamHealthy('demo', 's1')).toBe(true))
  }

  it('takes an initial capture and classifies it', async () => {
    const { watcher, children } = makeWatcher('opencode')
    watchers.push(watcher)
    watcher.start()
    await connectOpencode(children[0], '■■■■■⬝⬝⬝  esc interrupt')
    expect(readSessionStatus('demo', 's1')).toBe('running')
    expect(children[0].writes.join('')).toContain('capture-pane -pJ -t yaac:opencode.0')
  })

  it('re-captures after %output bursts (debounced) and reclassifies', async () => {
    const { watcher, children } = makeWatcher('opencode', { captureDebounceMs: 5 })
    watchers.push(watcher)
    watcher.start()
    const child = children[0]
    await connectOpencode(child, '■■■■■⬝⬝⬝  esc interrupt')

    child.feed('%output %2 chunk1\n%output %2 chunk2\n%output %2 chunk3\n')
    await vi.waitFor(() => expect(child.commandCount).toBe(3)) // one debounced capture
    child.feedReply('back to a quiet prompt')
    await vi.waitFor(() => expect(readSessionStatus('demo', 's1')).toBe('waiting'))
  })

  it('ignores %output from other panes', async () => {
    const { watcher, children } = makeWatcher('opencode', { captureDebounceMs: 5 })
    watchers.push(watcher)
    watcher.start()
    const child = children[0]
    await connectOpencode(child, 'quiet')
    child.feed('%output %9 not-the-agent\n')
    await new Promise((r) => setTimeout(r, 25))
    expect(child.commandCount).toBe(2)
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
