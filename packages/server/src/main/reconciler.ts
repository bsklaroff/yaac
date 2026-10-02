import { workspaceDriver } from '#drivers/driver'
import type {
  PassContext,
  ProjectRef,
  ReconcileStep,
  ReconcileTrigger,
  RuntimeSnapshot,
} from '#drivers/contract'
import { defaultReconcileSteps } from '#domain/reconcile'
import { listProjectRows } from '#db'
import { resolveProjectConfig } from '#domain/projects'
import { isWorkspaceTerminating } from '#runtime/status'
import { onConvergenceChange, type ChangeSource } from '#main/convergence'
import { serverLog } from '#log'
import type { YaacConfig } from '@yaac/shared/types'

/**
 * Event-driven reconciler. Two sources mark work dirty for one serialized
 * pass executor:
 *
 * - changes: convergence signals (workspace pods/Jobs, namespaces and their
 *   pods/services, live conversations, driver-stream health, egress proxy
 *   events). A pass runs after a short debounce so bursts coalesce.
 * - resync: every 60s, run every step. This covers missed events and is the
 *   clock for timed steps: a step with `every` runs on a resync at most that
 *   often, counted from its last successful run, so a failed one retries on
 *   the next resync.
 *
 * Passes never overlap (steps share module state) and run steps in order,
 * isolating each step's errors. Steps in a pass share one point-in-time
 * `RuntimeSnapshot`, created lazily by the first step that asks for it.
 */
export interface ReconcilerDeps {
  signal: AbortSignal
  /** Injected for tests — overrides the real step list. */
  steps?: ReconcileStep[]
  /** Change subscription; defaults to the convergence watches. */
  onDelta?: (fn: (source: ChangeSource) => void) => void
  resyncIntervalMs?: number
}

/** How long a pass waits after its first dirtying event, so a burst
 *  becomes one pass. Not cut short by an abort, which it delays at most
 *  this long. */
const DEBOUNCE_MS = 250

/**
 * Run the reconciler until `signal` aborts. Starts with an immediate full
 * pass; exits promptly on abort without interrupting an in-flight step.
 */
export async function startReconciler(deps: ReconcilerDeps): Promise<void> {
  const { signal } = deps
  const steps = deps.steps ?? defaultReconcileSteps()
  const resyncIntervalMs = deps.resyncIntervalMs ?? 60_000
  /** When each timed step last ran, by name. */
  const lastRun = new Map<string, number>()
  const dirty = new Set<ReconcileTrigger | 'resync'>()
  let wake: (() => void) | null = null
  const mark = (source: ReconcileTrigger | 'resync'): void => {
    dirty.add(source)
    wake?.()
  }
  ;(deps.onDelta ?? onConvergenceChange)(mark)
  const resyncTimer = setInterval(() => mark('resync'), resyncIntervalMs)
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
      await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS))
      if (signal.aborted) break
      const startedAt = Date.now()
      const taken = new Set(dirty)
      dirty.clear()
      const resync = taken.has('resync')
      const triggers = new Set<ReconcileTrigger>(
        [...taken].filter((t): t is ReconcileTrigger => t !== 'resync'),
      )
      let snapshot: RuntimeSnapshot | null = null
      let projects: Promise<ProjectRef[]> | null = null
      const projectConfigs = new Map<string, Promise<YaacConfig | undefined>>()
      const ctx: PassContext = {
        triggers,
        resync,
        signal,
        snapshot: () => (snapshot ??= workspaceDriver().snapshot(resync)),
        // Resolved here so runtime steps never read the db. A failed read
        // rejects rather than returning empty, because the orphan
        // collectors would treat an empty list as "collect everything".
        projects: () => (projects ??= listProjectRows()
          .then((rows) => rows.map(({ slug, id }) => ({ slug, id })))),
        // Memoized per project. No catch: a missing config resolves
        // `undefined` (all defaults), but an unreadable one (malformed,
        // invalid, mid-save) must reject. Returning `{}` instead would let
        // a step build and push the wrong image (e.g. a nestedContainers
        // chain without its nestable layer). The step skips this pass and
        // the next pass retries.
        projectConfig: (slug) => {
          let pending = projectConfigs.get(slug)
          if (!pending) {
            pending = resolveProjectConfig(slug).then((c) => c ?? undefined)
            projectConfigs.set(slug, pending)
          }
          return pending
        },
        // Not memoized: a stop that lands mid-pass must be seen at once.
        terminating: (workspaceId) => isWorkspaceTerminating(workspaceId),
      }
      for (const step of steps) {
        // On shutdown, finish the in-flight step but start no more.
        if (signal.aborted) return
        if (!resync && !step.triggers.some((t) => triggers.has(t))) continue
        // Half a resync of slack, so a resync pass that starts a little late
        // never pushes a timed step to the following resync.
        const last = lastRun.get(step.name)
        if (step.every !== undefined && last !== undefined
          && startedAt - last < step.every - resyncIntervalMs / 2) continue
        try {
          await step.run(ctx)
          if (step.every !== undefined) lastRun.set(step.name, startedAt)
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
