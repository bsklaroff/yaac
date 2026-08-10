import { describe, it, expect, beforeEach, vi } from 'vitest'
import type * as cleanupModule from '#features/worktrees/cleanup'
import type * as imagePrewarmModule from '#features/images/image-prewarm'
import type * as projectRegistryModule from '#features/cluster/project-registry'
import type * as titleGenerationModule from '#features/titles/title-generation'

// One reconcile step per module, faked so a pass can be driven without a
// substrate. Which steps a pass owes is the thing under test, so what each
// one does is beside the point — that it ran, and in what order, is not.
vi.mock('#features/worktrees/stale-worktrees', () => ({ reconcileStaleWorktrees: vi.fn() }))
vi.mock('#features/worktrees/spawn-reconcile', () => ({ reconcileSpawnRequests: vi.fn() }))
vi.mock('#features/worktrees/prewarm-reconcile', () => ({ reconcilePrewarmPool: vi.fn() }))
vi.mock('#features/worktrees/salvage-reconcile', () => ({ reconcileImageSalvage: vi.fn() }))
vi.mock('#features/worktrees/agent-session-registry', () => ({ reconcileAgentSessions: vi.fn() }))
vi.mock('#features/worktrees/cleanup', async (importOriginal) => ({
  ...(await importOriginal<typeof cleanupModule>()),
  gcOrphanEphemeralModuleDirs: vi.fn(),
}))
vi.mock('#features/images/builder-pod', () => ({ reconcileBuilderPodGc: vi.fn() }))
vi.mock('#features/images/build-cache-gc', () => ({ reconcileBuildCacheGc: vi.fn() }))
vi.mock('#features/images/image-prewarm', async (importOriginal) => ({
  ...(await importOriginal<typeof imagePrewarmModule>()),
  reconcileImagePrewarm: vi.fn(),
}))
vi.mock('#features/image-engine/image-gc', () => ({ reconcileHostImageGc: vi.fn() }))
vi.mock('#features/egress/proxy-reconcile', () => ({ reconcileProxySshKeys: vi.fn() }))
vi.mock('#features/egress/vcluster-attribution', () => ({ reconcileVclusterAttribution: vi.fn() }))
vi.mock('#features/cluster/vcluster-reconcile', () => ({ reconcileVclusters: vi.fn() }))
vi.mock('#features/cluster/project-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof projectRegistryModule>()),
  reconcileProjectRegistryGc: vi.fn(),
}))
vi.mock('#features/cluster/redirect-claim-reconcile', () => ({ reconcileRedirectClaims: vi.fn() }))
vi.mock('#features/titles/title-generation', async (importOriginal) => ({
  ...(await importOriginal<typeof titleGenerationModule>()),
  reconcileGeneratedTitles: vi.fn(),
}))

import {
  defaultReconcileSteps,
  startReconciler,
  type PassContext,
  type ReconcileStep,
  type ReconcileTrigger,
} from '#main/reconciler'
import type { DeltaSource } from '#platform/k8s/cluster-cache'
import type { TickSnapshot } from '#platform/k8s'
import type { AgentTool } from '@yaac/shared/types'
import { reconcileStaleWorktrees } from '#features/worktrees/stale-worktrees'
import { reconcileSpawnRequests } from '#features/worktrees/spawn-reconcile'
import { reconcilePrewarmPool } from '#features/worktrees/prewarm-reconcile'
import { reconcileImageSalvage } from '#features/worktrees/salvage-reconcile'
import { reconcileAgentSessions } from '#features/worktrees/agent-session-registry'
import { gcOrphanEphemeralModuleDirs } from '#features/worktrees/cleanup'
import { reconcileBuilderPodGc } from '#features/images/builder-pod'
import { reconcileBuildCacheGc } from '#features/images/build-cache-gc'
import { reconcileImagePrewarm } from '#features/images/image-prewarm'
import { reconcileHostImageGc } from '#features/image-engine/image-gc'
import { reconcileProxySshKeys } from '#features/egress/proxy-reconcile'
import { reconcileVclusterAttribution } from '#features/egress/vcluster-attribution'
import { reconcileVclusters } from '#features/cluster/vcluster-reconcile'
import { reconcileProjectRegistryGc } from '#features/cluster/project-registry'
import { reconcileRedirectClaims } from '#features/cluster/redirect-claim-reconcile'
import { reconcileGeneratedTitles } from '#features/titles/title-generation'

const ALL_STEP_FNS = [
  reconcileStaleWorktrees, reconcileSpawnRequests,
  reconcileBuilderPodGc, reconcileImagePrewarm, reconcilePrewarmPool,
  reconcileImageSalvage, reconcileProjectRegistryGc, reconcileAgentSessions,
  reconcileProxySshKeys, reconcileVclusters, reconcileVclusterAttribution,
  reconcileRedirectClaims, reconcileHostImageGc, reconcileBuildCacheGc,
  gcOrphanEphemeralModuleDirs, reconcileGeneratedTitles,
] as const

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
      makeStep(runs, 'a', ['worktree-pods']),
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
      makeStep(runs, 'pods-a', ['worktree-pods']),
      makeStep(runs, 'vc', ['vcluster-namespaces']),
      makeStep(runs, 'pods-b', ['worktree-pods', 'poll']),
    ])
    await flush()
    runs.length = 0

    h.emit('worktree-pods')
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
    const h = start([makeStep(runs, 'pods', ['worktree-pods'])])
    await flush()
    runs.length = 0

    h.emit('worktree-pods')
    h.emit('worktree-pods')
    h.emit('worktree-pods')
    await flush()
    expect(runs).toHaveLength(1)
    h.abort()
    await h.done
  })

  it('deltas arriving mid-pass queue a follow-up pass', async () => {
    const runs: StepRuns = []
    let emitted = false
    const h = start([
      makeStep(runs, 'pods', ['worktree-pods'], () => {
        if (!emitted) {
          emitted = true
          h.emit('worktree-pods')
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
    const h = start([makeStep(runs, 'a', ['worktree-pods'])], {
      onPass: () => { throw new Error('listener broke') },
    })
    await flush()
    h.emit('worktree-pods')
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
    h.emit('worktree-pods')
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

/** Drive one pass over the real step list with the engine's skip rule (the
 *  engine's own filtering is asserted above with injected steps). */
async function runPass(
  triggers: ReconcileTrigger[],
  opts: { resync?: boolean; defaultTool?: AgentTool } = {},
): Promise<void> {
  const resync = opts.resync ?? false
  const ctx: PassContext = {
    triggers: new Set(triggers),
    resync,
    signal: new AbortController().signal,
    snapshot: () => ({} as TickSnapshot),
    defaultTool: () => Promise.resolve(opts.defaultTool),
  }
  for (const step of defaultReconcileSteps()) {
    if (!resync && !step.triggers.some((t) => ctx.triggers.has(t))) continue
    await step.run(ctx)
  }
}

describe('defaultReconcileSteps', () => {
  beforeEach(() => {
    for (const fn of ALL_STEP_FNS) vi.mocked(fn).mockReset().mockResolvedValue(undefined)
  })

  // The reaper runs first (so counts reflect just-reaped worktrees by the
  // time the prewarm pool runs) and titles run last, after the conversation
  // sweep, so a just-captured opening message is eligible in the same pass.
  it('reaps first and generates titles last', () => {
    const names = defaultReconcileSteps().map((s) => s.name)
    expect(names[0]).toBe('stale-worktrees')
    expect(names[names.length - 1]).toBe('generated-titles')
  })

  // Titles run after the conversation sweep so a just-captured opening message
  // is eligible in the same pass — which only holds if they run on the passes
  // that sweep. An ACP worktree's first message is captured on the pass its
  // handshake triggers, and nothing else dirties that one.
  it('generates titles on whatever dirties the conversation sweep', () => {
    const steps = defaultReconcileSteps()
    const titles = steps.find((s) => s.name === 'generated-titles')!
    const sweep = steps.find((s) => s.name === 'agent-sessions')!
    expect([...titles.triggers].sort()).toEqual([...sweep.triggers].sort())
    expect([...titles.triggers].sort()).toEqual(['live-agents', 'worktree-pods'])
  })

  // The reaper is the destructive step, and the one a poll exists for:
  // in-pod tmux death is not a substrate event, so nothing else would ever
  // dirty it.
  it('runs only the steps a poll owes', async () => {
    await runPass(['poll'])
    expect(reconcileStaleWorktrees).toHaveBeenCalledTimes(1)
    expect(reconcileSpawnRequests).toHaveBeenCalledTimes(1)
    expect(reconcileProxySshKeys).toHaveBeenCalledTimes(1)
    // Not owed by a poll: a pod delta drives the sweep, and the hygiene
    // steps are throttled internally off the resync.
    expect(reconcileAgentSessions).not.toHaveBeenCalled()
    expect(reconcileBuilderPodGc).not.toHaveBeenCalled()
  })

  // The conversation sweep is the only substrate step that reads the
  // watcher's live set, and for `acp` that set is where a conversation's id
  // first appears — out of an in-pod handshake no informer can see. Without
  // this trigger the row (and the webapp's chat pane) waits for the next
  // resync.
  it('runs only the conversation sweep and titles when the live agent set changes', async () => {
    await runPass(['live-agents'])
    expect(reconcileAgentSessions).toHaveBeenCalledTimes(1)
    expect(reconcileGeneratedTitles).toHaveBeenCalledTimes(1)
    // And nothing else — asserted over every step, not just the destructive
    // ones, so a future edit that hangs another step off `live-agents` fails
    // here rather than shipping. A set change says nothing about pods, and
    // the reaper and the vcluster GC both delete.
    for (const fn of ALL_STEP_FNS) {
      if (fn === reconcileAgentSessions || fn === reconcileGeneratedTitles) continue
      expect(fn).not.toHaveBeenCalled()
    }
  })

  it('runs every step on a resync, whatever dirtied the pass', async () => {
    await runPass([], { resync: true })
    for (const fn of ALL_STEP_FNS) expect(fn).toHaveBeenCalledTimes(1)
  })

  // A leaked builder's memory reservation is what stops the next build
  // from scheduling, and a spare's create joins builds already running, so
  // these three are ordered rather than merely present.
  it('keeps the GC → prewarm → pool order', async () => {
    const order: string[] = []
    vi.mocked(reconcileBuilderPodGc).mockImplementation(() => {
      order.push('gc')
      return Promise.resolve()
    })
    vi.mocked(reconcileImagePrewarm).mockImplementation(() => {
      order.push('prewarm')
      return Promise.resolve()
    })
    vi.mocked(reconcilePrewarmPool).mockImplementation(() => {
      order.push('pool')
      return Promise.resolve()
    })
    await runPass([], { resync: true })
    expect(order).toEqual(['gc', 'prewarm', 'pool'])
  })

  // The configured default is a preference row, resolved once per pass and
  // handed down; claude is what a create falls back to.
  it('hands the pass’s default tool to the pool, defaulting to claude', async () => {
    await runPass([], { resync: true, defaultTool: 'codex' })
    expect(vi.mocked(reconcilePrewarmPool).mock.calls[0][0]).toBe('codex')
    await runPass([], { resync: true })
    expect(vi.mocked(reconcilePrewarmPool).mock.calls[1][0]).toBe('claude')
  })
})
