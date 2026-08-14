import { worktreeDriver } from '#drivers/driver'
import type { RuntimeSnapshot } from '#drivers/contract'
import { defaultReconcileSteps, type PassContext, type ReconcileStep, type ReconcileTrigger } from '#domain/reconcile'
import { getDefaultTool, listProjectRows } from '#db'
import { resolveProjectConfig } from '#domain/projects'
import { isWorktreeTerminating } from '#runtime/status'
import { onConvergenceChange, type ChangeSource } from '#main/convergence'
import { serverLog } from '#log'
import type { AgentTool, YaacConfig } from '@yaac/shared/types'

/**
 * Event-driven reconciler. Steps run when something they watch changes,
 * not on a fixed clock — two lanes feed one serialized pass executor:
 *
 * - changes: the convergence signals (worktree pods/Jobs,
 *   namespaces and their pods/services, the set of live conversations,
 *   driver-stream health, and what the egress proxy reports over its
 *   event stream) mark their sources dirty; a pass runs after a short
 *   debounce so event storms coalesce.
 * - resync: a 60s mark that runs EVERY step — the safety net for a missed
 *   event, and the driver for the internally-throttled hygiene steps
 *   (image prewarm/GC, salvage, builder-pod GC).
 *
 * There is no poll lane. Every source that had one now has an edge, and
 * the resync is what makes losing an edge cost latency rather than
 * correctness — which is the same reason the informer relists.
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
  resyncIntervalMs?: number
  debounceMs?: number
  /** Injected for tests — replaces the timer-based debounce wait. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
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
      let snapshot: RuntimeSnapshot | null = null
      let defaultTool: Promise<AgentTool | undefined> | null = null
      let projectSlugs: Promise<string[]> | null = null
      const projectConfigs = new Map<string, Promise<YaacConfig | undefined>>()
      const ctx: PassContext = {
        triggers,
        resync,
        signal,
        snapshot: () => (snapshot ??= worktreeDriver().snapshot(resync)),
        // No catch: a failed preference read rejects the accessor, which
        // fails (and stands down) exactly the steps that needed the answer
        // — churning a spare toward a fallback tool on a transient read
        // failure would be worse than warming nothing for one pass. An
        // UNSET preference resolves undefined, and the consumer's fallback
        // is for that case alone.
        defaultTool: () => (defaultTool ??= getDefaultTool()),
        // Same arrangement, and for the same reason: which projects exist
        // is a row question, so it is resolved once here and handed down —
        // a runtime step never reads db itself. An unreadable list
        // degrades to none rather than failing the pass, because every
        // consumer of it is upkeep that the next pass retries.
        projectSlugs: () => (projectSlugs ??= listProjectRows()
          .then((rows) => rows.map((r) => r.slug))
          .catch(() => [])),
        // Memoized per project rather than per pass, since a pass reads a
        // handful of different ones. Same reason as the two above: which
        // config a project has is answered by the layers that own disk, so
        // a runtime step is handed the answer.
        //
        // NO catch, unlike `projectSlugs` — and the difference is the point.
        // A project with no config file resolves `undefined`, which genuinely
        // means "all defaults". A config file that EXISTS and cannot be read
        // (malformed JSON, an invalid field, a mid-edit save) rejects, and
        // the rejection must reach the step: a consumer handed `{}` there
        // would build the wrong artifact and succeed at it — a
        // nestedContainers project's chain without its nestable layer — and
        // then push it. Rejecting stands that step down for the pass with a
        // log line, the way a failed `desiredWorktrees()` read stands the
        // reaper down, and the next pass retries a fixed file.
        projectConfig: (slug) => {
          let pending = projectConfigs.get(slug)
          if (!pending) {
            pending = resolveProjectConfig(slug).then((c) => c ?? undefined)
            projectConfigs.set(slug, pending)
          }
          return pending
        },
        // A plain read rather than a memoized one: the marks are in-memory
        // and a pass that starts before a stop lands must see the mark the
        // moment it appears, not a value frozen at pass start.
        terminating: (workspaceId) => isWorktreeTerminating(workspaceId),
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
    }
  } finally {
    clearInterval(resyncTimer)
    signal.removeEventListener('abort', onAbort)
  }
}

export { defaultReconcileSteps } from '#domain/reconcile'
export type { PassContext, ReconcileStep, ReconcileTrigger } from '#domain/reconcile'
