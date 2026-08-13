import { describe, it, expect, beforeEach, vi } from 'vitest'
import { snapshotFixture } from '@yaac/test-utils/fake-driver'
import { installRealWorktreeDriver } from '@yaac/test-utils/real-driver'
import { K8S_TRIGGERS } from '#drivers/k8s/lifecycle'
import type * as cleanupModule from '#domain/worktrees/cleanup'
import type * as imagePrewarmModule from '#drivers/k8s/images/image-prewarm'
import type * as projectRegistryModule from '#drivers/k8s/cluster/project-registry'
import type * as titleGenerationModule from '#domain/titles/title-generation'

// One reconcile step per module, faked so a pass can be driven without a
// substrate. Which steps a pass owes is the thing under test, so what each
// one does is beside the point — that it ran, and in what order, is not.
vi.mock('#domain/worktrees/stale-worktrees', () => ({ reconcileStaleWorktrees: vi.fn() }))
vi.mock('#domain/worktrees/spawn-reconcile', () => ({ reconcileSpawnRequests: vi.fn() }))
vi.mock('#domain/worktrees/prewarm-reconcile', () => ({ reconcilePrewarmPool: vi.fn() }))
vi.mock('#drivers/k8s/worktrees/salvage-reconcile', () => ({ reconcileImageSalvage: vi.fn() }))
vi.mock('#domain/worktrees/agent-session-registry', () => ({ reconcileAgentSessions: vi.fn() }))
vi.mock('#domain/worktrees/meta-import', () => ({ importLegacyMeta: vi.fn() }))
vi.mock('#domain/worktrees/cleanup', async (importOriginal) => ({
  ...(await importOriginal<typeof cleanupModule>()),
  gcOrphanEphemeralModuleDirs: vi.fn(),
}))
vi.mock('#drivers/k8s/images/builder-pod', () => ({ reconcileBuilderPodGc: vi.fn() }))
vi.mock('#drivers/k8s/images/build-cache-gc', () => ({ reconcileBuildCacheGc: vi.fn() }))
vi.mock('#drivers/k8s/images/store-writer', () => ({ reconcileNodeImageStores: vi.fn() }))
vi.mock('#drivers/k8s/images/image-prewarm', async (importOriginal) => ({
  ...(await importOriginal<typeof imagePrewarmModule>()),
  reconcileImagePrewarm: vi.fn(),
}))
vi.mock('#drivers/k8s/image-engine/image-gc', () => ({ reconcileHostImageGc: vi.fn() }))
vi.mock('#drivers/k8s/egress/proxy-reconcile', () => ({ reconcileProxySshKeys: vi.fn() }))
vi.mock('#drivers/k8s/egress/vcluster-attribution', () => ({ reconcileVclusterAttribution: vi.fn() }))
vi.mock('#drivers/k8s/cluster/vcluster-reconcile', () => ({ reconcileVclusters: vi.fn() }))
vi.mock('#drivers/k8s/cluster/project-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof projectRegistryModule>()),
  reconcileProjectRegistryGc: vi.fn(),
}))
vi.mock('#drivers/k8s/cluster/redirect-claim-reconcile', () => ({ reconcileRedirectClaims: vi.fn() }))
vi.mock('#domain/titles/title-generation', async (importOriginal) => ({
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
import type { AgentTool } from '@yaac/shared/types'
import { reconcileStaleWorktrees } from '#domain/worktrees/stale-worktrees'
import { reconcileSpawnRequests } from '#domain/worktrees/spawn-reconcile'
import { reconcilePrewarmPool } from '#domain/worktrees/prewarm-reconcile'
import { reconcileImageSalvage } from '#drivers/k8s/worktrees/salvage-reconcile'
import { reconcileAgentSessions } from '#domain/worktrees/agent-session-registry'
import { gcOrphanEphemeralModuleDirs } from '#domain/worktrees/cleanup'
import { importLegacyMeta } from '#domain/worktrees/meta-import'
import { reconcileBuilderPodGc } from '#drivers/k8s/images/builder-pod'
import { reconcileBuildCacheGc } from '#drivers/k8s/images/build-cache-gc'
import { reconcileNodeImageStores } from '#drivers/k8s/images/store-writer'
import { reconcileImagePrewarm } from '#drivers/k8s/images/image-prewarm'
import { reconcileHostImageGc } from '#drivers/k8s/image-engine/image-gc'
import { reconcileProxySshKeys } from '#drivers/k8s/egress/proxy-reconcile'
import { reconcileVclusterAttribution } from '#drivers/k8s/egress/vcluster-attribution'
import { reconcileVclusters } from '#drivers/k8s/cluster/vcluster-reconcile'
import { reconcileProjectRegistryGc } from '#drivers/k8s/cluster/project-registry'
import { reconcileRedirectClaims } from '#drivers/k8s/cluster/redirect-claim-reconcile'
import { reconcileGeneratedTitles } from '#domain/titles/title-generation'

const ALL_STEP_FNS = [
  importLegacyMeta, reconcileStaleWorktrees, reconcileSpawnRequests,
  reconcileBuilderPodGc, reconcileImagePrewarm, reconcilePrewarmPool,
  reconcileImageSalvage, reconcileNodeImageStores, reconcileProjectRegistryGc,
  reconcileAgentSessions,
  reconcileProxySshKeys, reconcileVclusters, reconcileVclusterAttribution,
  reconcileRedirectClaims, reconcileHostImageGc, reconcileBuildCacheGc,
  gcOrphanEphemeralModuleDirs, reconcileGeneratedTitles,
] as const

type StepRuns = Array<{ name: string; resync: boolean }>

interface Harness {
  emit: (source: ReconcileTrigger) => void
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
  resyncIntervalMs?: number
} = {}): Harness {
  const ctrl = new AbortController()
  let emit: Harness['emit'] = () => {}
  const harness: Harness = {
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
    resyncIntervalMs: opts.resyncIntervalMs ?? 60 * 60_000,
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
      makeStep(runs, 'c', ['status-streams']),
    ])
    await flush()
    expect(runs).toEqual([
      { name: 'a', resync: true },
      { name: 'b', resync: true },
      { name: 'c', resync: true },
    ])
    h.abort()
    await h.done
  })

  it('a delta runs only the steps it triggers, in list order', async () => {
    const runs: StepRuns = []
    const h = start([
      makeStep(runs, 'pods-a', ['worktree-pods']),
      makeStep(runs, 'vc', ['vcluster-namespaces']),
      makeStep(runs, 'pods-b', ['worktree-pods', 'status-streams']),
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

  // The only remaining lane besides the change deltas. It is what makes
  // losing an edge cost latency rather than correctness, so a step nothing
  // triggers must still run on it — and keep running, tick after tick.
  it('the resync timer runs every step, including untriggered ones', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    try {
      const runs: StepRuns = []
      const h = start([
        makeStep(runs, 'triggered', ['worktree-pods']),
        makeStep(runs, 'idle', []),
      ], { resyncIntervalMs: 60_000 })
      await flush()
      runs.length = 0

      await vi.advanceTimersByTimeAsync(60_000)
      await flush()
      expect(runs).toEqual([
        { name: 'triggered', resync: true },
        { name: 'idle', resync: true },
      ])

      runs.length = 0
      await vi.advanceTimersByTimeAsync(60_000)
      await flush()
      expect(runs).toEqual([
        { name: 'triggered', resync: true },
        { name: 'idle', resync: true },
      ])
      h.abort()
      await h.done
    } finally {
      vi.useRealTimers()
    }
  })

  it('isolates step failures and still runs the steps after them', async () => {
    const runs: StepRuns = []
    const h = start([
      { name: 'boom', triggers: [], run: () => Promise.reject(new Error('step failed')) },
      makeStep(runs, 'after', []),
    ])
    await flush()
    expect(runs).toEqual([{ name: 'after', resync: true }])
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
  opts: { resync?: boolean; defaultTool?: AgentTool; projectSlugs?: string[] } = {},
): Promise<void> {
  const resync = opts.resync ?? false
  const ctx: PassContext = {
    triggers: new Set(triggers),
    resync,
    signal: new AbortController().signal,
    snapshot: () => snapshotFixture(),
    defaultTool: () => Promise.resolve(opts.defaultTool),
    projectSlugs: () => Promise.resolve(opts.projectSlugs ?? []),
    projectConfig: () => Promise.resolve(undefined),
        terminating: () => false,
  }
  for (const step of defaultReconcileSteps()) {
    if (!resync && !step.triggers.some((t) => ctx.triggers.has(t))) continue
    await step.run(ctx)
  }
}

describe('defaultReconcileSteps', () => {
  beforeEach(() => {
    // The real driver, so its own contributed steps are the ones spliced
    // in — the modules behind them are mocked at the top of this file.
    installRealWorktreeDriver()
    for (const fn of ALL_STEP_FNS) vi.mocked(fn).mockReset()
  })

  // The document import runs before anything reads the columns it fills (the
  // spare flag a reap deletes checkouts on, the log offset the conversation
  // fold trusts panes against), the reaper next — so counts reflect
  // just-reaped worktrees by the time the prewarm pool runs — and titles
  // last, after the conversation sweep, so a just-captured opening message is
  // eligible in the same pass.
  it('imports then reaps first, and generates titles last', () => {
    const names = defaultReconcileSteps().map((s) => s.name)
    expect(names[0]).toBe('legacy-meta-import')
    expect(names[1]).toBe('stale-worktrees')
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
    expect([...titles.triggers].sort()).toEqual(['live-agents', 'workspaces'])
  })

  /** Assert that `triggers` runs exactly `expected` and nothing else. The
   *  negative half is over EVERY step, so hanging a new one off a source it
   *  has no business on fails here rather than shipping. */
  async function expectOnly(
    triggers: ReconcileTrigger[],
    expected: ReadonlyArray<(typeof ALL_STEP_FNS)[number]>,
  ): Promise<void> {
    await runPass(triggers)
    for (const fn of ALL_STEP_FNS) {
      if (expected.includes(fn)) expect(fn).toHaveBeenCalledTimes(1)
      else expect(fn).not.toHaveBeenCalled()
    }
  }

  // The reaper is the destructive step, and losing a worktree's driver
  // stream is its edge: in-pod tmux death is not a substrate event, so
  // nothing else would ever dirty it. Its slower sweeps ride the resync,
  // which is why this source pulls in the reaper and nothing more.
  it('runs only the reaper when a driver stream goes unhealthy', async () => {
    await expectOnly(['status-streams'], [reconcileStaleWorktrees])
  })

  // The proxy holds the calling pod's HTTP response open until the drain
  // answers it, so the enqueue is reported rather than waited for.
  it('runs only the spawn drain when the proxy reports a queued spawn', async () => {
    await expectOnly(['spawn-requests'], [reconcileSpawnRequests])
  })

  // A stream reattach is the one edge that says the proxy pod may have been
  // replaced — which is what both proxy heals were previously polling for.
  it('runs only the proxy heals on a stream reattach', async () => {
    await expectOnly(
      ['proxy-reconnect'],
      [reconcileProxySshKeys, reconcileVclusterAttribution],
    )
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
    })
    vi.mocked(reconcilePrewarmPool).mockImplementation(() => {
      order.push('pool')
      return Promise.resolve()
    })
    await runPass([], { resync: true })
    expect(order).toEqual(['gc', 'prewarm', 'pool'])
  })

  // A step that declares a trigger nothing raises compiles fine and fails
  // nothing — it just never runs on its edge and waits out the 60s resync,
  // which is latency, not an error. That is the whole exposure of an
  // open-ended `ReconcileTrigger`, and this is what closes it: the raise
  // sites in the driver are typed against K8S_TRIGGERS, and every trigger
  // the assembled list declares has to be a member of it.
  it('declares only triggers something can actually raise', () => {
    const raisable = new Set<string>(K8S_TRIGGERS)
    const declared = new Set(defaultReconcileSteps().flatMap((s) => s.triggers))
    expect([...declared].filter((t) => !raisable.has(t))).toEqual([])
    // What makes the check cover the whole vocabulary rather than the
    // mediators' quarter of it: the runtime's own groups are spliced in,
    // which only holds while the REAL runtime is installed. Swap the
    // beforeEach to the fake — whose `reconcileSteps()` returns empty
    // groups — and the set above quietly shrinks to the mediator steps
    // while still passing. So assert the runtime's own edges are in it.
    expect(declared).toContain('vcluster-namespaces')
    expect(declared).toContain('proxy-reconnect')
  })

  // The image-store rebuild is pinned between its two neighbours: after the
  // salvage, so a just-pushed generation is the one a build picks up, and
  // before the registry collect, which holds that registry read-only for
  // minutes. All three are the runtime's own steps, so this is the one
  // assertion that the group it hands back preserves an order stated only
  // in its comments — a resequencing there would otherwise reach nothing
  // that fails.
  it('rebuilds the image store between the salvage and the registry collect', () => {
    const names = defaultReconcileSteps().map((s) => s.name)
    expect(names.filter((n) => ['image-salvage', 'image-store', 'registry-gc'].includes(n)))
      .toEqual(['image-salvage', 'image-store', 'registry-gc'])
  })

  // The configured default is a preference row, resolved once per pass and
  // handed down; claude is what a create falls back to.
  it('hands the pass’s default tool to the pool, defaulting to claude', async () => {
    await runPass([], { resync: true, defaultTool: 'codex' })
    expect(vi.mocked(reconcilePrewarmPool).mock.calls[0][0]).toBe('codex')
    await runPass([], { resync: true })
    expect(vi.mocked(reconcilePrewarmPool).mock.calls[1][0]).toBe('claude')
  })

  // A FAILED preference read is not an unset preference: falling back to
  // claude on a transient db failure would retool a spare toward the
  // wrong tool and churn it back next pass. The accessor rejects, the step
  // fails (error-isolated by the engine), and the pool stands down for the
  // pass instead.
  it('stands the pool down when the preference read fails', async () => {
    const pool = defaultReconcileSteps().find((s) => s.name === 'prewarm-pool')!
    const ctx: PassContext = {
      triggers: new Set<ReconcileTrigger>(['worktree-pods']),
      resync: false,
      signal: new AbortController().signal,
      snapshot: () => snapshotFixture(),
      defaultTool: () => Promise.reject(new Error('db is gone')),
      projectSlugs: () => Promise.resolve([]),
      projectConfig: () => Promise.resolve(undefined),
        terminating: () => false,
    }
    await expect(pool.run(ctx)).rejects.toThrow('db is gone')
    expect(reconcilePrewarmPool).not.toHaveBeenCalled()
  })
})
