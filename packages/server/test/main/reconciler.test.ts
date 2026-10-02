import { describe, it, expect, beforeEach, vi } from 'vitest'
import { snapshotFixture } from '@yaac/test-utils/fake-driver'
import { installRealWorkspaceDriver } from '@yaac/test-utils/real-driver'
import { K8S_TRIGGERS } from '#drivers/k8s/lifecycle'
import type * as cleanupModule from '#domain/workspaces/cleanup'
import type * as imagePrewarmModule from '#drivers/k8s/images/image-prewarm'
import type * as projectRegistryModule from '#drivers/k8s/cluster/project-registry'
import type * as titleGenerationModule from '#domain/titles/title-generation'

// Each reconcile step is faked; these tests check which steps run and in
// what order, not what they do.
vi.mock('#domain/workspaces/stale-workspaces', () => ({ reconcileStaleWorkspaces: vi.fn() }))
vi.mock('#domain/workspaces/prewarm-reconcile', () => ({ reconcilePrewarmPool: vi.fn() }))
vi.mock('#drivers/k8s/workspaces/salvage-reconcile', () => ({ reconcileImageSalvage: vi.fn() }))
vi.mock('#domain/workspaces/agent-session-registry', () => ({ reconcileAgentSessions: vi.fn() }))
vi.mock('#domain/workspaces/cleanup', async (importOriginal) => ({
  ...(await importOriginal<typeof cleanupModule>()),
  gcOrphanEphemeralModuleDirs: vi.fn(),
}))
vi.mock('#drivers/k8s/images/main-registry-gc', () => ({ reconcileMainRegistryGc: vi.fn() }))
vi.mock('#drivers/k8s/images/store-writer', () => ({ reconcileNodeImageStores: vi.fn() }))
vi.mock('#drivers/k8s/images/image-prewarm', async (importOriginal) => ({
  ...(await importOriginal<typeof imagePrewarmModule>()),
  reconcileImagePrewarm: vi.fn(),
}))
vi.mock('#drivers/k8s/egress/proxy-registration', async (importOriginal) => ({
  ...(await importOriginal<typeof proxyRegistrationModule>()),
  reconcileRegistrationGc: vi.fn(),
}))
vi.mock('#domain/auth/runtime-push', () => ({
  adoptRefreshedToolCredentials: vi.fn(),
  pushCredentialsToRuntime: vi.fn(),
}))
vi.mock('#drivers/k8s/cluster/project-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof projectRegistryModule>()),
  reconcileProjectRegistryGc: vi.fn(),
}))
vi.mock('#domain/titles/title-generation', async (importOriginal) => ({
  ...(await importOriginal<typeof titleGenerationModule>()),
  reconcileGeneratedTitles: vi.fn(),
}))

import { startReconciler } from '#main/reconciler'
import { defaultReconcileSteps } from '#domain/reconcile'
import type { PassContext, ReconcileStep, ReconcileTrigger } from '#drivers/contract'
import { reconcileStaleWorkspaces } from '#domain/workspaces/stale-workspaces'
import { reconcilePrewarmPool } from '#domain/workspaces/prewarm-reconcile'
import { reconcileImageSalvage } from '#drivers/k8s/workspaces/salvage-reconcile'
import { reconcileAgentSessions } from '#domain/workspaces/agent-session-registry'
import { gcOrphanEphemeralModuleDirs } from '#domain/workspaces/cleanup'
import { reconcileMainRegistryGc } from '#drivers/k8s/images/main-registry-gc'
import { reconcileNodeImageStores } from '#drivers/k8s/images/store-writer'
import { reconcileImagePrewarm } from '#drivers/k8s/images/image-prewarm'
import { reconcileRegistrationGc } from '#drivers/k8s/egress/proxy-registration'
import { adoptRefreshedToolCredentials } from '#domain/auth/runtime-push'
import type * as proxyRegistrationModule from '#drivers/k8s/egress/proxy-registration'
import { reconcileProjectRegistryGc } from '#drivers/k8s/cluster/project-registry'
import { reconcileGeneratedTitles } from '#domain/titles/title-generation'

const ALL_STEP_FNS = [
  reconcileStaleWorkspaces,
  reconcileImagePrewarm, reconcilePrewarmPool,
  reconcileImageSalvage, reconcileNodeImageStores, reconcileProjectRegistryGc,
  reconcileAgentSessions,
  reconcileRegistrationGc, reconcileMainRegistryGc,
  gcOrphanEphemeralModuleDirs, adoptRefreshedToolCredentials, reconcileGeneratedTitles,
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
    // No debounce delay, so no fake timers are needed.
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
      makeStep(runs, 'a', ['workspace-pods']),
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
      makeStep(runs, 'pods-a', ['workspace-pods']),
      makeStep(runs, 'other', ['proxy-reconnect']),
      makeStep(runs, 'pods-b', ['workspace-pods', 'status-streams']),
    ])
    await flush()
    runs.length = 0

    h.emit('workspace-pods')
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
    const h = start([makeStep(runs, 'pods', ['workspace-pods'])])
    await flush()
    runs.length = 0

    h.emit('workspace-pods')
    h.emit('workspace-pods')
    h.emit('workspace-pods')
    await flush()
    expect(runs).toHaveLength(1)
    h.abort()
    await h.done
  })

  it('deltas arriving mid-pass queue a follow-up pass', async () => {
    const runs: StepRuns = []
    let emitted = false
    const h = start([
      makeStep(runs, 'pods', ['workspace-pods'], () => {
        if (!emitted) {
          emitted = true
          h.emit('workspace-pods')
        }
      }),
    ])
    await flush()
    // The resync pass re-marked itself, so one delta pass follows.
    expect(runs).toEqual([
      { name: 'pods', resync: true },
      { name: 'pods', resync: false },
    ])
    h.abort()
    await h.done
  })

  // The resync is the safety net for missed triggers, so it runs every
  // step on every tick.
  it('the resync timer runs every step, including untriggered ones', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    try {
      const runs: StepRuns = []
      const h = start([
        makeStep(runs, 'triggered', ['workspace-pods']),
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

    h.emit('workspace-pods')
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

/** Run one pass over the real step list with the engine's skip rule. */
async function runPass(
  triggers: ReconcileTrigger[],
  opts: { resync?: boolean } = {},
): Promise<void> {
  const resync = opts.resync ?? false
  const ctx: PassContext = {
    triggers: new Set(triggers),
    resync,
    signal: new AbortController().signal,
    snapshot: () => snapshotFixture(),
    projects: () => Promise.resolve([]),
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
    // The real driver contributes its steps; their modules are mocked above.
    installRealWorkspaceDriver()
    for (const fn of ALL_STEP_FNS) vi.mocked(fn).mockReset()
  })

  // Reaping first keeps the prewarm pool's counts current; titles run last so
  // a just-captured first message gets a title in the same pass.
  it('reaps first, and generates titles last', () => {
    const names = defaultReconcileSteps().map((s) => s.name)
    expect(names[0]).toBe('stale-workspaces')
    expect(names[names.length - 1]).toBe('generated-titles')
  })

  // So titles run in the same pass that captures an ACP workspace's first
  // message.
  it('generates titles on whatever dirties the conversation sweep', () => {
    const steps = defaultReconcileSteps()
    const titles = steps.find((s) => s.name === 'generated-titles')!
    const sweep = steps.find((s) => s.name === 'agent-sessions')!
    expect([...titles.triggers].sort()).toEqual([...sweep.triggers].sort())
    expect([...titles.triggers].sort()).toEqual(['live-agents', 'workspaces'])
  })

  /** Assert that `triggers` runs exactly `expected` and no other step. */
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

  // tmux dying in a pod is no cluster event, so a lost stream is the
  // reaper's only trigger.
  it('runs only the reaper when a driver stream goes unhealthy', async () => {
    await expectOnly(['status-streams'], [reconcileStaleWorkspaces])
  })

  // An `acp` conversation's id appears only in the live set, so without
  // this trigger its row would wait for the next resync.
  it('runs only the conversation sweep and titles when the live agent set changes', async () => {
    await runPass(['live-agents'])
    expect(reconcileAgentSessions).toHaveBeenCalledTimes(1)
    expect(reconcileGeneratedTitles).toHaveBeenCalledTimes(1)
    // No other step, since a live-set change says nothing about pods.
    for (const fn of ALL_STEP_FNS) {
      if (fn === reconcileAgentSessions || fn === reconcileGeneratedTitles) continue
      expect(fn).not.toHaveBeenCalled()
    }
  })

  it('runs every step on a resync, whatever dirtied the pass', async () => {
    await runPass([], { resync: true })
    for (const fn of ALL_STEP_FNS) expect(fn).toHaveBeenCalledTimes(1)
  })

  // A spare's create joins the builds the prewarm sweep started.
  it('keeps the prewarm → pool order', async () => {
    const order: string[] = []
    vi.mocked(reconcileImagePrewarm).mockImplementation(() => {
      order.push('prewarm')
    })
    vi.mocked(reconcilePrewarmPool).mockImplementation(() => {
      order.push('pool')
      return Promise.resolve()
    })
    await runPass([], { resync: true })
    expect(order).toEqual(['prewarm', 'pool'])
  })

  // A trigger nothing raises would silently wait for the 60s resync. The
  // driver raises only K8S_TRIGGERS, so every declared trigger must be one.
  it('declares only triggers something can actually raise', () => {
    const raisable = new Set<string>(K8S_TRIGGERS)
    const declared = new Set(defaultReconcileSteps().flatMap((s) => s.triggers))
    expect([...declared].filter((t) => !raisable.has(t))).toEqual([])
    // Make sure the real driver's steps are included; with the fake driver
    // the check above would pass on the mediator steps alone.
    expect(defaultReconcileSteps().map((s) => s.name)).toContain('registration-gc')
    expect(declared).toContain('proxy-refreshed')
  })

  // Its trigger must not also run the reaper.
  it('adopts a captured rotation on its own edge alone', async () => {
    await expectOnly(['proxy-refreshed'], [adoptRefreshedToolCredentials])
  })

  // After the salvage, so the rebuild picks up just-pushed images, and
  // before the registry collect, which makes the registry read-only for
  // minutes.
  it('rebuilds the image store between the salvage and the registry collect', () => {
    const names = defaultReconcileSteps().map((s) => s.name)
    expect(names.filter((n) => ['image-salvage', 'image-store', 'registry-gc'].includes(n)))
      .toEqual(['image-salvage', 'image-store', 'registry-gc'])
  })

  // The pool resolves each project's spare config itself.
  it('hands the pool the pass view', async () => {
    await runPass([], { resync: true })
    expect(vi.mocked(reconcilePrewarmPool)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(reconcilePrewarmPool).mock.calls[0]).toHaveLength(1)
  })
})
