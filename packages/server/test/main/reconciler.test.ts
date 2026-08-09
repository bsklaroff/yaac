import { describe, it, expect, vi } from 'vitest'
import {
  defaultReconcileSteps,
  startReconciler,
  type PassContext,
  type ReconcileStep,
} from '#main/reconciler'
import type { DeltaSource } from '#platform/k8s/cluster-cache'

type StepRuns = Array<{ name: string; resync: boolean }>

interface Harness {
  passes: number
  emit: (source: DeltaSource) => void
  abort: () => void
  done: Promise<void>
}

function makeStep(
  runs: StepRuns,
  name: string,
  triggers: ReconcileStep['triggers'],
  impl?: (ctx: PassContext) => void | Promise<void>,
): ReconcileStep {
  return {
    name,
    triggers,
    run: async (ctx) => {
      runs.push({ name, resync: ctx.resync })
      await impl?.(ctx)
    },
  }
}

function start(steps: ReconcileStep[], opts: {
  pollIntervalMs?: number
  resyncIntervalMs?: number
  onPass?: () => void | Promise<void>
} = {}): Harness {
  const ctrl = new AbortController()
  let emit: Harness['emit'] = () => {}
  const harness: Harness = {
    passes: 0,
    emit: (s) => emit(s),
    abort: () => ctrl.abort(),
    done: Promise.resolve(),
  }
  harness.done = startReconciler({
    signal: ctrl.signal,
    steps,
    onDelta: (fn) => { emit = fn },
    // Immediate debounce keeps the tests deterministic without fake timers.
    sleep: async () => {},
    pollIntervalMs: opts.pollIntervalMs ?? 60 * 60_000,
    resyncIntervalMs: opts.resyncIntervalMs ?? 60 * 60_000,
    onPass: opts.onPass ?? (() => { harness.passes += 1 }),
  })
  return harness
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))
}

describe('startReconciler', () => {
  it('runs an immediate full pass (every step, resync snapshot)', async () => {
    const runs: StepRuns = []
    const h = start([
      makeStep(runs, 'a', ['session-pods']),
      makeStep(runs, 'b', []),
      makeStep(runs, 'c', ['poll']),
    ])
    await flush()
    expect(runs).toEqual([
      { name: 'a', resync: true },
      { name: 'b', resync: true },
      { name: 'c', resync: true },
    ])
    expect(h.passes).toBe(1)
    h.abort()
    await h.done
  })

  it('a delta runs only the steps it triggers, in list order', async () => {
    const runs: StepRuns = []
    const h = start([
      makeStep(runs, 'pods-a', ['session-pods']),
      makeStep(runs, 'vc', ['vcluster-namespaces']),
      makeStep(runs, 'pods-b', ['session-pods', 'poll']),
    ])
    await flush()
    runs.length = 0

    h.emit('session-pods')
    await flush()
    expect(runs).toEqual([
      { name: 'pods-a', resync: false },
      { name: 'pods-b', resync: false },
    ])
    h.abort()
    await h.done
  })

  it('coalesces a burst of deltas into one pass', async () => {
    const runs: StepRuns = []
    const h = start([makeStep(runs, 'pods', ['session-pods'])])
    await flush()
    runs.length = 0

    h.emit('session-pods')
    h.emit('session-pods')
    h.emit('session-pods')
    await flush()
    expect(runs).toHaveLength(1)
    h.abort()
    await h.done
  })

  it('deltas arriving mid-pass queue a follow-up pass', async () => {
    const runs: StepRuns = []
    let emitted = false
    const h = start([
      makeStep(runs, 'pods', ['session-pods'], () => {
        if (!emitted) {
          emitted = true
          h.emit('session-pods')
        }
      }),
    ])
    await flush()
    // First (resync) pass re-marked itself → one follow-up delta pass.
    expect(runs).toEqual([
      { name: 'pods', resync: true },
      { name: 'pods', resync: false },
    ])
    h.abort()
    await h.done
  })

  it('poll and resync timers mark their lanes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    try {
      const runs: StepRuns = []
      const h = start([
        makeStep(runs, 'poller', ['poll']),
        makeStep(runs, 'idle', []),
      ], { pollIntervalMs: 5_000, resyncIntervalMs: 60_000 })
      await flush()
      runs.length = 0

      await vi.advanceTimersByTimeAsync(5_000)
      await flush()
      expect(runs).toEqual([{ name: 'poller', resync: false }])

      runs.length = 0
      await vi.advanceTimersByTimeAsync(55_000)
      await flush()
      // 11 more poll marks landed, and the 60s resync ran everything once.
      expect(runs.filter((r) => r.name === 'idle')).toEqual([{ name: 'idle', resync: true }])
      expect(runs.some((r) => r.name === 'poller')).toBe(true)
      h.abort()
      await h.done
    } finally {
      vi.useRealTimers()
    }
  })

  it('isolates step failures and still calls onPass', async () => {
    const runs: StepRuns = []
    const h = start([
      { name: 'boom', triggers: [], run: () => Promise.reject(new Error('step failed')) },
      makeStep(runs, 'after', []),
    ])
    await flush()
    expect(runs).toEqual([{ name: 'after', resync: true }])
    expect(h.passes).toBe(1)
    h.abort()
    await h.done
  })

  it('swallows onPass errors', async () => {
    const runs: StepRuns = []
    const h = start([makeStep(runs, 'a', ['session-pods'])], {
      onPass: () => { throw new Error('listener broke') },
    })
    await flush()
    h.emit('session-pods')
    await flush()
    expect(runs).toHaveLength(2)
    h.abort()
    await h.done
  })

  it('exits promptly on abort and starts no further steps', async () => {
    const runs: StepRuns = []
    const h = start([
      makeStep(runs, 'first', [], () => h.abort()),
      makeStep(runs, 'second', []),
    ])
    await h.done
    expect(runs).toEqual([{ name: 'first', resync: true }])

    // Deltas after abort never wake it again.
    h.emit('session-pods')
    await flush()
    expect(runs).toHaveLength(1)
  })

  it('resolves on abort while idle', async () => {
    const h = start([makeStep([], 'a', [])])
    await flush()
    h.abort()
    await expect(h.done).resolves.toBeUndefined()
  })
})

describe('defaultReconcileSteps', () => {
  // The substrate half of a pass is one step, and what is left brackets it:
  // the desired set has to be published before the reaper inside the herd's
  // pass can judge an absence against it, and titles are generated after the
  // conversation sweep so a just-captured opening message is eligible in the
  // same pass.
  it('brackets the herd’s pass with the two steps that touch rows', () => {
    expect(defaultReconcileSteps().map((s) => s.name))
      .toEqual(['desired-workspaces', 'herd', 'generated-titles'])
  })

  // Which of its own steps a pass owes is the herd's business, so its step
  // takes every source rather than being triggered on a subset.
  it('owes the herd a pass on any source', () => {
    const herdStep = defaultReconcileSteps().find((s) => s.name === 'herd')!
    expect([...herdStep.triggers].sort()).toEqual([
      'poll',
      'session-jobs',
      'session-pods',
      'vcluster-configmaps',
      'vcluster-namespaces',
      'vcluster-pods',
      'vcluster-services',
    ])
  })
})
