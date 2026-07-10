import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('@yaac/server/lib/k8s/kubectl', () => ({
  dataDirHash: vi.fn(() => 'ddh0123456789abc'),
  k8sNamespace: vi.fn(() => 'test-ns'),
  kubectlGetJson: vi.fn(),
}))

import {
  PodWatcher,
  createJsonStreamParser,
  getActivePodWatcher,
  setActivePodWatcher,
  type WatchChild,
} from '@yaac/server/lib/k8s/pod-watch'
import { JOB_NAME_LABEL, LABEL_PROJECT, LABEL_SESSION_ID, LABEL_TOOL, type SessionPod } from '@yaac/server/lib/k8s/pods'

describe('createJsonStreamParser', () => {
  it('parses newline-delimited compact JSON values', () => {
    const values: unknown[] = []
    const parser = createJsonStreamParser((v) => values.push(v))
    parser.push('{"a":1}\n{"b":2}\n')
    expect(values).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('handles chunks split mid-value', () => {
    const values: unknown[] = []
    const parser = createJsonStreamParser((v) => values.push(v))
    parser.push('{"type":"ADD')
    parser.push('ED","object":{}}\n')
    expect(values).toEqual([{ type: 'ADDED', object: {} }])
  })

  it('accumulates a value that spans multiple lines', () => {
    const values: unknown[] = []
    const parser = createJsonStreamParser((v) => values.push(v))
    parser.push('{\n  "a": 1\n}\n{"b":2}\n')
    expect(values).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('skips blank lines', () => {
    const values: unknown[] = []
    const parser = createJsonStreamParser((v) => values.push(v))
    parser.push('\n\n{"a":1}\n\n')
    expect(values).toEqual([{ a: 1 }])
  })

  it('drops an over-long unparseable candidate instead of buffering forever', () => {
    const values: unknown[] = []
    const parser = createJsonStreamParser((v) => values.push(v), 16)
    parser.push('{"broken": unterminated garbage\n')
    parser.push('{"a":1}\n')
    expect(values).toEqual([{ a: 1 }])
  })
})

function rawPodObject(opts: {
  podName: string
  sessionId: string
  slug?: string
  phase?: string
  deletionTimestamp?: string
}): Record<string, unknown> {
  return {
    metadata: {
      name: opts.podName,
      labels: {
        [JOB_NAME_LABEL]: `yaac-${opts.slug ?? 'demo'}-${opts.sessionId}`,
        [LABEL_SESSION_ID]: opts.sessionId,
        [LABEL_PROJECT]: opts.slug ?? 'demo',
        [LABEL_TOOL]: 'claude',
      },
      creationTimestamp: '2026-06-01T00:00:00Z',
      ...(opts.deletionTimestamp ? { deletionTimestamp: opts.deletionTimestamp } : {}),
    },
    status: { phase: opts.phase ?? 'Running' },
  }
}

function sessionPod(opts: { podName: string; sessionId: string; slug?: string }): SessionPod {
  return {
    jobName: `yaac-${opts.slug ?? 'demo'}-${opts.sessionId}`,
    podName: opts.podName,
    sessionId: opts.sessionId,
    projectSlug: opts.slug ?? 'demo',
    tool: 'claude',
    phase: 'Running',
    running: true,
    createdAtMs: Date.parse('2026-06-01T00:00:00Z'),
    labels: {
      [JOB_NAME_LABEL]: `yaac-${opts.slug ?? 'demo'}-${opts.sessionId}`,
      [LABEL_SESSION_ID]: opts.sessionId,
      [LABEL_PROJECT]: opts.slug ?? 'demo',
      [LABEL_TOOL]: 'claude',
    },
  }
}

class FakeWatchChild implements WatchChild {
  private stdoutCbs: Array<(chunk: Buffer | string) => void> = []
  private exitCbs: Array<(...args: unknown[]) => void> = []
  killed = false
  stdout = { on: (_e: 'data', cb: (chunk: Buffer | string) => void): void => { this.stdoutCbs.push(cb) } }
  stderr = { on: (): void => { /* unused */ } }
  on(event: 'exit' | 'error', cb: (...args: unknown[]) => void): void {
    if (event === 'exit') this.exitCbs.push(cb)
  }
  kill(): boolean {
    this.killed = true
    return true
  }
  emitEvent(type: string, object: unknown): void {
    for (const cb of this.stdoutCbs) cb(`${JSON.stringify({ type, object })}\n`)
  }
  emitExit(): void {
    for (const cb of this.exitCbs) cb(0)
  }
}

function makeWatcher(opts: {
  seeds?: SessionPod[][]
  relistIntervalMs?: number
  restartDelayMs?: number
} = {}): { watcher: PodWatcher; children: FakeWatchChild[]; listPods: ReturnType<typeof vi.fn> } {
  const children: FakeWatchChild[] = []
  const seeds = opts.seeds ?? [[]]
  let seedIdx = 0
  const listPods = vi.fn(() => {
    const seed = seeds[Math.min(seedIdx, seeds.length - 1)]
    seedIdx += 1
    return Promise.resolve(seed)
  })
  const watcher = new PodWatcher({
    spawnWatch: () => {
      const child = new FakeWatchChild()
      children.push(child)
      return child
    },
    listPods,
    relistIntervalMs: opts.relistIntervalMs ?? 60_000,
    restartDelayMs: opts.restartDelayMs ?? 5,
    log: () => { /* quiet */ },
  })
  return { watcher, children, listPods }
}

let active: PodWatcher | null = null

afterEach(() => {
  active?.stop()
  active = null
  setActivePodWatcher(null)
})

async function started(w: { watcher: PodWatcher; children: FakeWatchChild[] }): Promise<FakeWatchChild> {
  active = w.watcher
  w.watcher.start()
  await vi.waitFor(() => {
    if (w.children.length === 0) throw new Error('watch child not spawned yet')
  })
  return w.children[0]
}

describe('PodWatcher', () => {
  it('seeds the cache from the injected list before watching', async () => {
    const pod = sessionPod({ podName: 'p1', sessionId: 's1' })
    const w = makeWatcher({ seeds: [[pod]] })
    const changed = vi.fn()
    w.watcher.onChange(changed)
    await started(w)
    expect(w.watcher.getPods()).toEqual([pod])
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('applies ADDED / MODIFIED / DELETED watch events and notifies per change', async () => {
    const w = makeWatcher()
    const changed = vi.fn()
    w.watcher.onChange(changed)
    const child = await started(w)

    child.emitEvent('ADDED', rawPodObject({ podName: 'p1', sessionId: 's1' }))
    expect(w.watcher.getPods()).toHaveLength(1)
    expect(w.watcher.getPods()[0].running).toBe(true)

    child.emitEvent('MODIFIED', rawPodObject({ podName: 'p1', sessionId: 's1', phase: 'Succeeded' }))
    expect(w.watcher.getPods()[0].running).toBe(false)
    expect(w.watcher.getPods()[0].phase).toBe('Succeeded')

    child.emitEvent('DELETED', rawPodObject({ podName: 'p1', sessionId: 's1', phase: 'Succeeded' }))
    expect(w.watcher.getPods()).toHaveLength(0)
    expect(changed).toHaveBeenCalledTimes(3)
  })

  it('marks a terminating pod (deletionTimestamp) as not running', async () => {
    const w = makeWatcher()
    const child = await started(w)
    child.emitEvent('MODIFIED', rawPodObject({
      podName: 'p1', sessionId: 's1', deletionTimestamp: '2026-06-01T01:00:00Z',
    }))
    expect(w.watcher.getPods()[0].running).toBe(false)
  })

  it('does not notify for a MODIFIED event that changes nothing', async () => {
    const w = makeWatcher()
    const changed = vi.fn()
    w.watcher.onChange(changed)
    const child = await started(w)
    child.emitEvent('ADDED', rawPodObject({ podName: 'p1', sessionId: 's1' }))
    child.emitEvent('MODIFIED', rawPodObject({ podName: 'p1', sessionId: 's1' }))
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('ignores events whose object fails the session-pod schema', async () => {
    const w = makeWatcher()
    const child = await started(w)
    child.emitEvent('ADDED', { metadata: { name: 'not-a-session-pod' } })
    expect(w.watcher.getPods()).toHaveLength(0)
  })

  it('filters getPods by project slug', async () => {
    const a = sessionPod({ podName: 'p1', sessionId: 's1', slug: 'alpha' })
    const b = sessionPod({ podName: 'p2', sessionId: 's2', slug: 'beta' })
    const w = makeWatcher({ seeds: [[a, b]] })
    await started(w)
    expect(w.watcher.getPods('alpha')).toEqual([a])
    expect(w.watcher.getPods()).toHaveLength(2)
  })

  it('respawns the watch after a child exit and re-seeds (ghost rows drop)', async () => {
    const ghost = sessionPod({ podName: 'ghost', sessionId: 's1' })
    const fresh = sessionPod({ podName: 'p2', sessionId: 's2' })
    const w = makeWatcher({ seeds: [[ghost], [fresh]], restartDelayMs: 5 })
    const child = await started(w)
    expect(w.watcher.getPods()).toEqual([ghost])
    child.emitExit()
    await vi.waitFor(() => {
      expect(w.children).toHaveLength(2)
      expect(w.watcher.getPods()).toEqual([fresh])
    })
  })

  it('relists on the interval so a missed DELETED event cannot ghost forever', async () => {
    const ghost = sessionPod({ podName: 'ghost', sessionId: 's1' })
    const w = makeWatcher({ seeds: [[ghost], []], relistIntervalMs: 20 })
    await started(w)
    // First seed put the ghost in the cache; the interval relist (second
    // seed, empty) must remove it without any watch event arriving.
    await vi.waitFor(() => expect(w.watcher.getPods()).toHaveLength(0))
    expect(w.listPods.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('keeps the cache when a relist fails (cluster hiccup)', async () => {
    const pod = sessionPod({ podName: 'p1', sessionId: 's1' })
    const seeds = [[pod]]
    let calls = 0
    const listPods = vi.fn(() => {
      calls += 1
      if (calls > 1) return Promise.reject(new Error('cluster down'))
      return Promise.resolve(seeds[0])
    })
    const children: FakeWatchChild[] = []
    const watcher = new PodWatcher({
      spawnWatch: () => {
        const child = new FakeWatchChild()
        children.push(child)
        return child
      },
      listPods,
      relistIntervalMs: 10,
      log: () => { /* quiet */ },
    })
    active = watcher
    watcher.start()
    await vi.waitFor(() => expect(listPods.mock.calls.length).toBeGreaterThan(1))
    expect(watcher.getPods()).toEqual([pod])
  })

  it('stop() kills the child and prevents respawn', async () => {
    const w = makeWatcher({ restartDelayMs: 1 })
    const child = await started(w)
    w.watcher.stop()
    expect(child.killed).toBe(true)
    child.emitExit()
    await new Promise((r) => setTimeout(r, 20))
    expect(w.children).toHaveLength(1)
  })
})

describe('active pod watcher singleton', () => {
  it('is null by default and returns what was set', () => {
    expect(getActivePodWatcher()).toBeNull()
    const w = makeWatcher()
    setActivePodWatcher(w.watcher)
    expect(getActivePodWatcher()).toBe(w.watcher)
    setActivePodWatcher(null)
    expect(getActivePodWatcher()).toBeNull()
  })
})
