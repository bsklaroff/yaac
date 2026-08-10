import { getDefaultTool, pushDesiredWorkspaces } from '#features/records'
import {
  gcOrphanEphemeralModuleDirs,
  inFlightWorktreeIds,
  reconcileAgentSessions,
  reconcileImageSalvage,
  reconcilePrewarmPool,
  reconcileSpawnRequests,
  reconcileStaleWorktrees,
} from '#features/worktrees'
import { reconcileProxySshKeys, reconcileVclusterAttribution } from '#features/egress'
import {
  reconcileProjectRegistryGc,
  reconcileRedirectClaims,
  reconcileVclusters,
} from '#features/cluster'
import { reconcileBuildCacheGc, reconcileBuilderPodGc, reconcileImagePrewarm } from '#features/images'
import { reconcileHostImageGc } from '#features/image-engine'
import { reconcileGeneratedTitles } from '#features/titles'
import { createTickSnapshot, type TickSnapshot } from '#platform/k8s'
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
 * point-in-time view (`TickSnapshot`), created lazily on first use so the
 * desired-set step ahead of them publishes before the view is taken.
 */
export type ReconcileTrigger = ChangeSource | 'poll'

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
  /** The pass's shared substrate view — memoized, created on first use. */
  snapshot: () => TickSnapshot
  /** The configured default tool — memoized, read from its preference row
   *  on first use and handed to the steps that need it, so no substrate
   *  step reads a row itself. */
  defaultTool: () => Promise<AgentTool | undefined>
}

/**
 * The sources on which a worktree may have appeared or gone.
 *
 * ONE constant rather than two equal lists, because the equality is an
 * invariant: the desired set is refreshed on exactly these, and the stale
 * reaper judges an absence against it on exactly these, so "absence is
 * only ever judged against a set from the same pass" holds by
 * construction.
 */
export const DESIRED_SET_TRIGGERS: readonly ReconcileTrigger[] = [
  'worktree-pods',
  'worktree-jobs',
  'poll',
]

/**
 * One flat list, in the order a pass runs it. The two row-touching steps
 * bracket the substrate steps: the desired set is published before the
 * reaper can judge an absence against it, and titles are generated after
 * the conversation sweep so a just-captured opening message is eligible
 * in the same pass.
 */
export function defaultReconcileSteps(): ReconcileStep[] {
  return [
    // What the server records as existing, and which of those it is still
    // creating — published for the reaper, on the reaper's own triggers,
    // so the two cannot drift apart.
    { name: 'desired-workspaces', triggers: DESIRED_SET_TRIGGERS,
      run: () => pushDesiredWorkspaces(inFlightWorktreeIds()) },
    // The stale reaper. Poll is in its triggers because in-pod tmux death
    // is not a substrate event.
    { name: 'stale-worktrees', triggers: DESIRED_SET_TRIGGERS,
      run: (ctx) => reconcileStaleWorktrees(ctx.snapshot()) },
    // Service in-worktree `yaac-spawn` requests queued at the egress proxy.
    // The drain resolves who called from pod labels; what a request MEANS
    // (tool precedence, the fan-out cap, the minted id) is `decideSpawn`'s.
    { name: 'spawn-requests', triggers: ['poll'],
      run: (ctx) => reconcileSpawnRequests({}, ctx.snapshot()) },
    // Leaked trust-split builder pods (server restarted mid-build) — the
    // label sweep backstop. Throttled internally. Ahead of image-prewarm on
    // purpose: a leaked builder's memory reservation is what stops the next
    // build from scheduling, so it has to go before builds are launched.
    { name: 'builder-pod-gc', triggers: [], run: () => reconcileBuilderPodGc() },
    // Keep every project's image chain built and pushed (detached tasks).
    // Before the prewarm pool: a spare's create then joins the
    // already-running builds. Throttled internally.
    { name: 'image-prewarm', triggers: [], run: () => reconcileImagePrewarm() },
    // Keep one prewarmed spare per active project (after the stale sweep so
    // counts reflect just-reaped worktrees). No-op when the pool size is 0.
    { name: 'prewarm-pool', triggers: ['worktree-pods'],
      run: async (ctx) => reconcilePrewarmPool((await ctx.defaultTool()) ?? 'claude', ctx.snapshot()) },
    // Mid-worktree image salvage (nested engines → project registry).
    // Throttled internally per worktree; salvages run detached.
    { name: 'image-salvage', triggers: [], run: () => reconcileImageSalvage() },
    // Blob reclaim in one project registry per pass. It cannot wait for a
    // project to go idle — an active one never does — so it takes a
    // read-only maintenance window instead, and detaches. Throttled
    // internally; after the salvage, so a just-pushed generation is the
    // one that survives the collect.
    { name: 'registry-gc', triggers: [], run: () => reconcileProjectRegistryGc() },
    // Which agent sessions each worktree holds, which are live, and what
    // each opened with — read from the worktree's metadata document, with
    // the in-pod hook's session-starts log folded in (or, under `acp`, from
    // the handshake), crossed with the watcher's live agent set. The
    // opening message rides along because the sweep has just resolved the
    // transcript it would be read from; title generation runs after this
    // step for that reason. `live-agents` is here and nowhere else: it is
    // the only step that reads the watcher's live set, and it is what turns
    // a fresh ACP handshake into a conversation row within a debounce
    // instead of within a resync.
    { name: 'agent-sessions', triggers: ['worktree-pods', 'live-agents'],
      run: (ctx) => reconcileAgentSessions(ctx.snapshot()) },
    // ssh-agent heal only (attach-only probe, never bootstraps): agent
    // identities are memory-only by design and need the server to re-upload
    // them after a proxy pod replacement.
    { name: 'proxy-ssh-keys', triggers: ['poll'], run: () => reconcileProxySshKeys() },
    // Per-worktree vclusters: orphan GC + host-side kubeconfig heal.
    { name: 'vclusters', triggers: ['vcluster-namespaces', 'worktree-pods', 'worktree-jobs'],
      run: (ctx) => reconcileVclusters(Date.now(), ctx.snapshot()) },
    // yaac-in-yaac: tell the outer proxy which outer worktree owns each
    // vcluster's pods. Poll re-pushes cover outer-proxy restarts.
    { name: 'vcluster-attribution',
      triggers: ['vcluster-namespaces', 'vcluster-pods', 'poll'],
      run: (ctx) => reconcileVclusterAttribution(ctx.snapshot()) },
    // yaac-in-yaac: validate each vcluster's redirect claims and republish
    // them for netd. Claim documents arrive through the vcluster syncer, so
    // a ConfigMap delta is the signal; pod deltas matter too, since a claim
    // is only as valid as the pod IPs it names.
    { name: 'redirect-claims',
      triggers: ['vcluster-namespaces', 'vcluster-configmaps', 'vcluster-pods'],
      run: (ctx) => reconcileRedirectClaims(ctx.snapshot()) },
    // Host podman image GC. Throttled internally to every few hours.
    { name: 'host-image-gc', triggers: [], run: () => reconcileHostImageGc() },
    // Registry-side counterpart: retire step-cache tags no build has used
    // in a cache-ttl and collect their blobs. Throttled internally, and it
    // stands down while anything is pushing.
    { name: 'build-cache-gc', triggers: [], run: () => reconcileBuildCacheGc() },
    // Per-worktree `.cached-packages/modules/<id>` dirs whose runtime is
    // gone — leftovers from crashes and host reboots. A startup sweep, run
    // from the loop rather than from attach because it must not delete a
    // dir a create is staging into, and which worktrees are mid-create is
    // the desired set the pass published above. Self-gating: once per
    // server life.
    { name: 'orphan-modules-gc', triggers: [], run: () => gcOrphanEphemeralModuleDirs() },
    // Model-generated titles for untitled worktrees, after the
    // conversation sweep so a freshly captured prompt is eligible the same
    // pass — which means it owes a pass on whatever dirties that sweep.
    // Cheap when there is nothing to do.
    { name: 'generated-titles', triggers: ['worktree-pods', 'live-agents'],
      run: () => reconcileGeneratedTitles() },
  ]
}

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
        defaultTool: () => (defaultTool ??= getDefaultTool().catch(() => undefined)),
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
