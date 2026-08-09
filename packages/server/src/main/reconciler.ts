import { getDefaultTool, pushDesiredWorkspaces } from '#features/records'
import { inFlightWorktreeIds } from '#features/sessions'
import { reconcileGeneratedTitles } from '#features/titles'
import { DESIRED_SET_TRIGGERS, herd, type HerdChangeSource } from '#herd'
import { serverLog } from '#log'

/**
 * Event-driven reconciler. Steps run when something they watch changes,
 * not on a fixed clock — three lanes feed one serialized pass executor:
 *
 * - changes: the herd's watches (session pods/Jobs, vcluster namespaces and
 *   their pods/services, and the set of live conversations) mark their
 *   sources dirty; a pass runs after a short debounce so event storms
 *   coalesce.
 * - poll: a 5s mark for the state no watch can see — the proxy's queued
 *   spawn requests and in-pod tmux death (the stale reaper). These are
 *   fork-free: cache reads, one local proxy HTTP call, and tmux probes
 *   that short-circuit on healthy status streams.
 * - resync: a 60s mark that runs EVERY step — the safety net for a missed
 *   event, and the driver for the internally-throttled hygiene steps
 *   (image prewarm/GC, salvage, builder-pod GC).
 *
 * Passes never overlap (steps share module state) and preserve the step
 * order below; each pass isolates step errors.
 *
 * There are only three steps, because the substrate half of a pass is one of
 * them: the herd runs its own ordered steps over its own view of the
 * substrate (docs/plans/herd-split.md). What is left here is what reads or
 * writes rows, and it brackets the herd's pass — the desired set has to be
 * published before the reaper can judge an absence against it, and titles
 * are generated after the conversation sweep so a just-captured opening
 * message is eligible in the same pass.
 */
export type ReconcileTrigger = HerdChangeSource | 'poll'

export interface ReconcileStep {
  name: string
  /** Sources that dirty this step; every step also runs on resync. */
  triggers: readonly ReconcileTrigger[]
  run: (ctx: PassContext) => Promise<void>
}

export interface PassContext {
  /** Which sources dirtied this pass. */
  triggers: ReadonlySet<ReconcileTrigger>
  /** Whether this is the periodic run-everything pass. */
  resync: boolean
  /** Aborts the pass. Handed down so a step that fans out into many of its
   *  own can stop starting them the moment shutdown signals. */
  signal: AbortSignal
}

/** Every source there is: the herd's pass owes work on any of them, and
 *  decides internally which of its own steps a given one dirties. */
const HERD_TRIGGERS: readonly ReconcileTrigger[] = [
  'session-pods',
  'session-jobs',
  'vcluster-namespaces',
  'vcluster-pods',
  'vcluster-services',
  'vcluster-configmaps',
  'live-agents',
  'poll',
]

export function defaultReconcileSteps(): ReconcileStep[] {
  return [
    // Tell the herd what the server records as existing, and which of those
    // it is still creating. Before the herd's pass, which is where the reaper
    // runs: absence only means something against a set from this pass, not
    // the last one — and the reaper's own triggers are this same shared
    // constant, so the two can't drift apart.
    { name: 'desired-workspaces', triggers: DESIRED_SET_TRIGGERS,
      run: () => pushDesiredWorkspaces(inFlightWorktreeIds()) },
    // Everything that touches the substrate, in the herd's own order. It
    // takes the whole trigger set rather than being triggered itself: which
    // of its steps a pass owes is its business, and a resync owes all of
    // them. The configured default tool goes down as an argument — it is a
    // preference row, and a herd never looks one up.
    { name: 'herd', triggers: HERD_TRIGGERS, run: async ({ triggers, resync, signal }) => {
      const defaultTool = await getDefaultTool()
      await herd().lifecycle.reconcile({
        triggers,
        resync,
        signal,
        ...(defaultTool !== undefined ? { defaultTool } : {}),
      })
    } },
    // Model-generated titles for untitled sessions, after the herd's
    // conversation sweep so a freshly captured prompt is eligible the same
    // pass. Which means it owes a pass on whatever dirties that sweep: an ACP
    // worktree's opening message is captured on the pass its handshake
    // triggers, and same-pass eligibility is the whole point of the ordering.
    // Cheap when there is nothing to do — a row listing against a set of
    // worktrees already attempted.
    { name: 'generated-titles', triggers: ['session-pods', 'live-agents'],
      run: () => reconcileGeneratedTitles() },
  ]
}

export interface ReconcilerDeps {
  signal: AbortSignal
  /** Injected for tests — overrides the real step list. */
  steps?: ReconcileStep[]
  /** Change subscription; defaults to the herd's own watches. */
  onDelta?: (fn: (source: HerdChangeSource) => void) => void
  pollIntervalMs?: number
  resyncIntervalMs?: number
  debounceMs?: number
  /** Injected for tests — replaces the timer-based debounce wait. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  /**
   * Called after every completed pass. Used to push a fresh state snapshot
   * to webapp clients once reconciliation has settled. Errors are swallowed
   * so a bad listener can't wedge the reconciler.
   */
  onPass?: () => void | Promise<void>
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Run the reconciler until `signal` aborts. Starts with an immediate full
 * pass; exits promptly on abort without interrupting an in-flight step.
 */
export async function startReconciler(deps: ReconcilerDeps): Promise<void> {
  const { signal } = deps
  const steps = deps.steps ?? defaultReconcileSteps()
  const sleep = deps.sleep ?? defaultSleep
  const debounceMs = deps.debounceMs ?? 250
  const dirty = new Set<ReconcileTrigger | 'resync'>()
  let wake: (() => void) | null = null
  const mark = (source: ReconcileTrigger | 'resync'): void => {
    dirty.add(source)
    wake?.()
  }
  ;(deps.onDelta ?? ((fn) => { herd().lifecycle.onChange(fn) }))(mark)
  const pollTimer = setInterval(() => mark('poll'), deps.pollIntervalMs ?? 5_000)
  const resyncTimer = setInterval(() => mark('resync'), deps.resyncIntervalMs ?? 60_000)
  const onAbort = (): void => wake?.()
  signal.addEventListener('abort', onAbort, { once: true })
  mark('resync') // immediate first pass covers every step

  try {
    while (!signal.aborted) {
      if (dirty.size === 0) {
        await new Promise<void>((resolve) => { wake = resolve })
        wake = null
      }
      if (signal.aborted) break
      // Let an event storm (a seeding informer, a multi-pod teardown)
      // coalesce into one pass instead of one pass per delta.
      await sleep(debounceMs, signal)
      if (signal.aborted) break
      const taken = new Set(dirty)
      dirty.clear()
      const resync = taken.has('resync')
      const triggers = new Set<ReconcileTrigger>(
        [...taken].filter((t): t is ReconcileTrigger => t !== 'resync'),
      )
      for (const step of steps) {
        // Stop starting steps as soon as shutdown signals — an in-flight
        // step still completes (the shutdown path bounds the drain), but we
        // don't pile more work behind a signal the server has already seen.
        if (signal.aborted) return
        if (!resync && !step.triggers.some((t) => triggers.has(t))) continue
        try {
          await step.run({ triggers, resync, signal })
        } catch (err) {
          serverLog(`[server] reconcile step ${step.name} failed: ${String(err)}`)
        }
      }
      if (deps.onPass) {
        try {
          await deps.onPass()
        } catch (err) {
          serverLog(`[server] reconcile onPass failed: ${String(err)}`)
        }
      }
    }
  } finally {
    clearInterval(pollTimer)
    clearInterval(resyncTimer)
    signal.removeEventListener('abort', onAbort)
  }
}
