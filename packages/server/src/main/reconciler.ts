import { reconcileStaleSessions } from '#features/sessions/reconcile/stale-sessions'
import { captureOpencodeFirstMessages } from '#features/sessions/agents/opencode'
import { reconcileImageSalvage } from '#features/sessions/reconcile/salvage-reconcile'
import { reconcileProxySshKeys } from '#features/sessions/reconcile/proxy-reconcile'
import { reconcileSpawnRequests } from '#features/sessions/reconcile/spawn-reconcile'
import { reconcileVclusters } from '#features/sessions/reconcile/vcluster-reconcile'
import { reconcileInnerRedirects } from '#features/sessions/reconcile/inner-redirect-reconcile'
import { reconcileStaleTproxyRules } from '#features/sessions/reconcile/tproxy-gc-reconcile'
import { reconcileHostImageGc } from '#features/images/image-gc'
import { reconcileBuilderPodGc } from '#features/images/builder-pod'
import { reconcileVclusterAttribution } from '#features/sessions/reconcile/vcluster-attribution-reconcile'
import { reconcilePrewarmPool } from '#features/images/prewarm-reconcile'
import { reconcileSchedules } from '#features/schedules/schedule-reconcile'
import { reconcileImagePrewarm } from '#features/images/image-prewarm'
import { reconcileGeneratedTitles } from '#features/titles/title-generation'
import { createTickSnapshot, type TickSnapshot } from '#platform/k8s/tick-snapshot'
import { getActiveClusterCache, type DeltaSource } from '#platform/k8s/cluster-cache'
import { serverLog } from '#log'

/**
 * Event-driven reconciler. Steps run when something they watch changes,
 * not on a fixed clock — three lanes feed one serialized pass executor:
 *
 * - deltas: ClusterCache informer events (session pods/Jobs, vcluster
 *   namespaces and their pods/services) mark their sources dirty; a pass
 *   runs after a short debounce so event storms coalesce.
 * - poll: a 5s mark for the state no watch can see — the proxy's queued
 *   spawn requests, due cron schedules, and in-pod tmux death (the stale
 *   reaper). These are fork-free: cache reads, one local proxy HTTP call,
 *   one DB query, and tmux probes that short-circuit on healthy status
 *   streams.
 * - resync: a 60s mark that runs EVERY step — the safety net for a missed
 *   event, and the driver for the internally-throttled hygiene steps
 *   (image prewarm/GC, salvage, tproxy GC, builder-pod GC).
 *
 * Passes never overlap (steps share module state) and preserve the step
 * order below; each pass shares one TickSnapshot and isolates step errors.
 */
export type ReconcileTrigger = DeltaSource | 'poll'

export interface ReconcileStep {
  name: string
  /** Sources that dirty this step; every step also runs on resync. */
  triggers: readonly ReconcileTrigger[]
  run: (snapshot: TickSnapshot) => Promise<void>
}

export function defaultReconcileSteps(): ReconcileStep[] {
  return [
    // Poll keeps dead-tmux detection at today's cadence (not a k8s event),
    // and keeps the stale sweep ordered before a schedule fire.
    { name: 'stale-sessions', triggers: ['session-pods', 'session-jobs', 'poll'],
      run: (s) => reconcileStaleSessions(s) },
    // Fire due cron schedules (detached headless session creates).
    { name: 'schedules', triggers: ['poll'], run: () => reconcileSchedules() },
    // Service in-session `yaac-spawn` requests queued at the egress proxy.
    { name: 'spawn-requests', triggers: ['poll'], run: () => reconcileSpawnRequests() },
    // Keep every project's image chain built and pushed (detached tasks).
    // Before the prewarm pool: a spare's createSession then joins the
    // already-running builds. Throttled internally.
    { name: 'image-prewarm', triggers: [], run: () => reconcileImagePrewarm() },
    // Keep one prewarmed spare per active project (after the stale sweep so
    // counts reflect just-reaped sessions). No-op when the pool size is 0.
    { name: 'prewarm-pool', triggers: ['session-pods'], run: (s) => reconcilePrewarmPool(s) },
    // Mid-session image salvage (nested engines → shared store). Throttled
    // internally per session; salvages run detached.
    { name: 'image-salvage', triggers: [], run: () => reconcileImageSalvage() },
    { name: 'opencode-first-messages', triggers: ['session-pods'],
      run: (s) => captureOpencodeFirstMessages(s) },
    // Model-generated titles for untitled sessions (right after first-message
    // capture so a fresh opencode prompt is eligible the same pass).
    { name: 'generated-titles', triggers: ['session-pods'],
      run: () => reconcileGeneratedTitles() },
    // ssh-agent heal only (attach-only probe, never bootstraps): agent
    // identities are memory-only by design and need the server to re-upload
    // them after a proxy pod replacement.
    { name: 'proxy-ssh-keys', triggers: ['poll'], run: () => reconcileProxySshKeys() },
    // Per-session vclusters: orphan GC + host-side kubeconfig heal.
    { name: 'vclusters', triggers: ['vcluster-namespaces', 'session-pods', 'session-jobs'],
      run: (s) => reconcileVclusters(Date.now(), s) },
    // yaac-in-yaac: project the inner egress redirect for a vcluster's synced
    // pods once its inner proxy is up (or prune it when gone).
    { name: 'inner-redirects', triggers: ['vcluster-namespaces', 'vcluster-services'],
      run: (s) => reconcileInnerRedirects(s) },
    // yaac-in-yaac: tell the outer proxy which outer session owns each
    // vcluster's pods. Poll re-pushes cover outer-proxy restarts.
    { name: 'vcluster-attribution',
      triggers: ['vcluster-namespaces', 'vcluster-pods', 'poll'],
      run: (s) => reconcileVclusterAttribution(s) },
    // GC the TPROXY rules Cilium leaks when a CEC is deleted. Throttled
    // internally. After inner-redirects so a CEC it just applied reads live.
    { name: 'tproxy-gc', triggers: [], run: () => reconcileStaleTproxyRules() },
    // Host podman image GC. Throttled internally to every few hours.
    { name: 'host-image-gc', triggers: [], run: () => reconcileHostImageGc() },
    // Leaked trust-split builder pods (server crashed mid-build) — the label
    // sweep backstop. Throttled internally.
    { name: 'builder-pod-gc', triggers: [], run: () => reconcileBuilderPodGc() },
  ]
}

export interface ReconcilerDeps {
  signal: AbortSignal
  /** Injected for tests — overrides the real step list. */
  steps?: ReconcileStep[]
  /** Delta subscription; defaults to the active ClusterCache. */
  onDelta?: (fn: (source: DeltaSource) => void) => void
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
  ;(deps.onDelta ?? ((fn) => getActiveClusterCache()?.onDelta(fn)))(mark)
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
      const snapshot = createTickSnapshot(resync)
      for (const step of steps) {
        // Stop starting steps as soon as shutdown signals — an in-flight
        // step still completes (the shutdown path bounds the drain), but we
        // don't pile more work behind a signal the server has already seen.
        if (signal.aborted) return
        if (!resync && !step.triggers.some((t) => taken.has(t))) continue
        try {
          await step.run(snapshot)
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
