import {
  captureSessionPrompts,
  reconcilePrewarmPool,
  reconcileAgentSessions,
  reconcileImageSalvage,
  reconcileSpawnRequests,
  reconcileStaleSessions,
} from '#features/sessions'
import { reconcileProxySshKeys, reconcileVclusterAttribution } from '#features/egress'
import {
  reconcileProjectRegistryGc,
  reconcileRedirectClaims,
  reconcileVclusters,
} from '#features/cluster'
import { reconcileBuildCacheGc, reconcileBuilderPodGc, reconcileImagePrewarm } from '#features/images'
import { reconcileHostImageGc } from '#features/image-engine'
import { reconcileGeneratedTitles } from '#features/titles'
import { type DeltaSource, type TickSnapshot, createTickSnapshot, getActiveClusterCache } from '#platform/k8s'
import { serverLog } from '#log'

/**
 * Event-driven reconciler. Steps run when something they watch changes,
 * not on a fixed clock — three lanes feed one serialized pass executor:
 *
 * - deltas: ClusterCache informer events (session pods/Jobs, vcluster
 *   namespaces and their pods/services) mark their sources dirty; a pass
 *   runs after a short debounce so event storms coalesce.
 * - poll: a 5s mark for the state no watch can see — the proxy's queued
 *   spawn requests and in-pod tmux death (the stale reaper). These are
 *   fork-free: cache reads, one local proxy HTTP call, and tmux probes
 *   that short-circuit on healthy status streams.
 * - resync: a 60s mark that runs EVERY step — the safety net for a missed
 *   event, and the driver for the internally-throttled hygiene steps
 *   (image prewarm/GC, salvage, builder-pod GC).
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
    // Poll keeps dead-tmux detection at today's cadence (not a k8s event).
    { name: 'stale-sessions', triggers: ['session-pods', 'session-jobs', 'poll'],
      run: (s) => reconcileStaleSessions(s) },
    // Service in-session `yaac-spawn` requests queued at the egress proxy.
    { name: 'spawn-requests', triggers: ['poll'], run: (s) => reconcileSpawnRequests({}, s) },
    // Leaked trust-split builder pods (server restarted mid-build) — the
    // label sweep backstop. Throttled internally. Ahead of image-prewarm on
    // purpose: a leaked builder's memory reservation is what stops the next
    // build from scheduling, so it has to go before builds are launched.
    { name: 'builder-pod-gc', triggers: [], run: () => reconcileBuilderPodGc() },
    // Keep every project's image chain built and pushed (detached tasks).
    // Before the prewarm pool: a spare's createSession then joins the
    // already-running builds. Throttled internally.
    { name: 'image-prewarm', triggers: [], run: () => reconcileImagePrewarm() },
    // Keep one prewarmed spare per active project (after the stale sweep so
    // counts reflect just-reaped sessions). No-op when the pool size is 0.
    { name: 'prewarm-pool', triggers: ['session-pods'], run: (s) => reconcilePrewarmPool(s) },
    // Mid-session image salvage (nested engines → project registry). Throttled
    // internally per session; salvages run detached.
    { name: 'image-salvage', triggers: [], run: () => reconcileImageSalvage() },
    // Blob reclaim in one project registry per pass. It cannot wait for a
    // project to go idle — an active one never does — so it takes a
    // read-only maintenance window instead, and detaches. Throttled
    // internally; after the salvage, so a just-pushed generation is the
    // one that survives the collect.
    { name: 'registry-gc', triggers: [], run: () => reconcileProjectRegistryGc() },
    // Which agent sessions each worktree holds, and which are live — read
    // from the in-pod hook's link tree crossed with the watcher's pane set.
    // Before session-prompts, whose work list is the conversations this
    // discovers.
    { name: 'agent-sessions', triggers: ['session-pods'],
      run: (s) => reconcileAgentSessions(s) },
    // First user message onto each conversation, and the founding one onto
    // the worktree — once per subject, so every display path reads the
    // prompt instead of parsing a transcript.
    { name: 'session-prompts', triggers: ['session-pods'],
      run: (s) => captureSessionPrompts(s) },
    // Model-generated titles for untitled sessions (right after first-message
    // capture so a freshly captured prompt is eligible the same pass).
    { name: 'generated-titles', triggers: ['session-pods'],
      run: () => reconcileGeneratedTitles() },
    // ssh-agent heal only (attach-only probe, never bootstraps): agent
    // identities are memory-only by design and need the server to re-upload
    // them after a proxy pod replacement.
    { name: 'proxy-ssh-keys', triggers: ['poll'], run: () => reconcileProxySshKeys() },
    // Per-session vclusters: orphan GC + host-side kubeconfig heal.
    { name: 'vclusters', triggers: ['vcluster-namespaces', 'session-pods', 'session-jobs'],
      run: (s) => reconcileVclusters(Date.now(), s) },
    // yaac-in-yaac: tell the outer proxy which outer session owns each
    // vcluster's pods. Poll re-pushes cover outer-proxy restarts.
    { name: 'vcluster-attribution',
      triggers: ['vcluster-namespaces', 'vcluster-pods', 'poll'],
      run: (s) => reconcileVclusterAttribution(s) },
    // yaac-in-yaac: validate each vcluster's redirect claims and republish
    // them for netd. Claim documents arrive through the vcluster syncer, so
    // a ConfigMap delta is the signal; pod deltas matter too, since a claim
    // is only as valid as the pod IPs it names.
    { name: 'redirect-claims',
      triggers: ['vcluster-namespaces', 'vcluster-configmaps', 'vcluster-pods'],
      run: (s) => reconcileRedirectClaims(s) },
    // Host podman image GC. Throttled internally to every few hours.
    { name: 'host-image-gc', triggers: [], run: () => reconcileHostImageGc() },
    // Registry-side counterpart: retire step-cache tags no build has used
    // in a cache-ttl and collect their blobs. Throttled internally, and it
    // stands down while anything is pushing.
    { name: 'build-cache-gc', triggers: [], run: () => reconcileBuildCacheGc() },
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
