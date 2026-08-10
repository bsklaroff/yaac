import { createTickSnapshot } from '#platform/k8s'
import type { TickSnapshot } from '#platform/k8s'
import { defaultReconcileSteps, type PassContext, type ReconcileStep, type ReconcileTrigger } from '#domain/reconcile'
import { getDefaultTool } from '#records'
import { onConvergenceChange, type ChangeSource } from '#main/convergence'
import { serverLog } from '#log'
import type { AgentTool } from '@yaac/shared/types'

/**
 * Event-driven reconciler. Steps run when something they watch changes,
 * not on a fixed clock — three lanes feed one serialized pass executor:
 *
 * - changes: the convergence watches (worktree pods/Jobs, vcluster
 *   namespaces and their pods/services, and the set of live conversations)
 *   mark their sources dirty; a pass runs after a short debounce so event
 *   storms coalesce.
 * - poll: a 5s mark for the state no watch can see — the proxy's queued
 *   spawn requests and in-pod tmux death (the stale reaper). These are
 *   fork-free: cache reads, one local proxy HTTP call, and tmux probes
 *   that short-circuit on healthy status streams.
 * - resync: a 60s mark that runs EVERY step — the safety net for a missed
 *   event, and the driver for the internally-throttled hygiene steps
 *   (image prewarm/GC, salvage, builder-pod GC).
 *
 * Passes never overlap (steps share module state) and preserve the step
 * order below; each pass isolates step errors. Substrate steps share one
 * point-in-time view (`TickSnapshot`), created lazily so only a pass that
 * actually runs a substrate step takes one — the first triggered step
 * takes the view, and every later step in the pass sees the same instant.
 */
export interface ReconcilerDeps {
  signal: AbortSignal
  /** Injected for tests — overrides the real step list. */
  steps?: ReconcileStep[]
  /** Change subscription; defaults to the convergence watches. */
  onDelta?: (fn: (source: ChangeSource) => void) => void
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
  ;(deps.onDelta ?? onConvergenceChange)(mark)
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
      let snapshot: TickSnapshot | null = null
      let defaultTool: Promise<AgentTool | undefined> | null = null
      const ctx: PassContext = {
        triggers,
        resync,
        signal,
        snapshot: () => (snapshot ??= createTickSnapshot(resync)),
        // No catch: a failed preference read rejects the accessor, which
        // fails (and stands down) exactly the steps that needed the answer
        // — churning a spare toward a fallback tool on a transient read
        // failure would be worse than warming nothing for one pass. An
        // UNSET preference resolves undefined, and the consumer's fallback
        // is for that case alone.
        defaultTool: () => (defaultTool ??= getDefaultTool()),
      }
      for (const step of steps) {
        // Stop starting steps as soon as shutdown signals — an in-flight
        // step still completes (the shutdown path bounds the drain), but we
        // don't pile more work behind a signal the server has already seen.
        if (signal.aborted) return
        if (!resync && !step.triggers.some((t) => triggers.has(t))) continue
        try {
          await step.run(ctx)
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

export { defaultReconcileSteps } from '#domain/reconcile'
export type { PassContext, ReconcileStep, ReconcileTrigger } from '#domain/reconcile'
