import { reconcileStaleSessions, captureOpencodeFirstMessages } from '#features/sessions/list'
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
import { serverLog } from '#log'

export interface BackgroundLoopDeps {
  signal: AbortSignal
  /** Tick interval in ms. Default: 5000. */
  intervalMs?: number
  /**
   * Injected for tests — replaces the default timer-based wait. Must
   * resolve after `ms` elapses, or reject with an AbortError when the
   * signal fires.
   */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  /**
   * Injected for tests — overrides the tick body. Each element runs in
   * sequence with per-step error isolation, and receives the tick's
   * shared cluster-listing snapshot. Defaults to the real tick.
   */
  tickSteps?: Array<(snapshot: TickSnapshot) => Promise<void>>
  /**
   * Called after every completed tick (including the immediate first
   * one). Used to push a fresh state snapshot to webapp clients once
   * reconciliation has settled. Errors are swallowed so a bad listener
   * can't wedge the loop.
   */
  onTick?: () => void | Promise<void>
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    if (signal.aborted) {
      clearTimeout(timer)
      resolve()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function defaultTickSteps(): Array<(snapshot: TickSnapshot) => Promise<void>> {
  return [
    reconcileStaleSessions,
    // Fire due cron schedules (detached headless session creates). After the
    // stale sweep so a fire never lands in a namespace mid-reap.
    () => reconcileSchedules(),
    // Service in-session `yaac-spawn` requests queued at the egress proxy
    // (detached headless session creates, same shape as schedule fires).
    () => reconcileSpawnRequests(),
    // Keep every project's image chain built and pushed (detached tasks, so
    // a minutes-long build never blocks the tick). Before the prewarm pool:
    // a spare's createSession then joins the already-running builds.
    // Throttled internally — most ticks are a no-op.
    () => reconcileImagePrewarm(),
    // Keep one prewarmed spare per active project (after the stale sweep so
    // counts reflect just-reaped sessions). No-op when the pool size is 0.
    reconcilePrewarmPool,
    // Mid-session image salvage (nested engines → shared store), so
    // teardown only ships a delta. Internally throttled per session; the
    // salvages themselves run detached, never blocking the tick.
    () => reconcileImageSalvage(),
    captureOpencodeFirstMessages,
    // Model-generated titles for untitled sessions (right after first-message
    // capture so a fresh opencode prompt is eligible the same tick). Detached
    // per-session tasks; inference serializes inside the summarizer.
    reconcileGeneratedTitles,
    // ssh-agent heal only (attach-only probe, never bootstraps): session
    // registrations survive proxy pod replacement via the /data
    // write-through, but agent identities are memory-only by design and
    // need the server to re-upload them. The proxy itself is deployed
    // lazily by the first session create's ensureRunning().
    reconcileProxySshKeys,
    // Per-session vclusters: orphan GC + host-side kubeconfig heal.
    (snapshot) => reconcileVclusters(Date.now(), snapshot),
    // yaac-in-yaac: project the inner egress redirect for a vcluster's synced
    // pods once its inner proxy is up (or prune it when gone). Throttled
    // internally — most ticks are a no-op.
    (snapshot) => reconcileInnerRedirects(Date.now(), snapshot),
    // yaac-in-yaac: tell the outer proxy which outer session owns each
    // vcluster's pods, so their chained egress is attributed + allowlist-judged
    // (the proxy can't resolve those cross-namespace source pods itself).
    // Throttled internally — most ticks are a no-op.
    (snapshot) => reconcileVclusterAttribution(Date.now(), snapshot),
    // GC the TPROXY rules Cilium leaks when a CEC is deleted (vcluster
    // churn residue). Throttled internally — most ticks are a no-op. After
    // reconcileInnerRedirects so a CEC it just (re)applied reads as live.
    () => reconcileStaleTproxyRules(),
    // Host podman image GC: retire stale content-hash generations and
    // prune the chains they pinned. Throttled internally to every few
    // hours; a no-op on e2e servers (per-run namespaces skip it).
    () => reconcileHostImageGc(),
    // Leaked trust-split builder pods (server crashed mid-build): the
    // normal path deletes them inline; this label sweep is the backstop.
    // Throttled internally — most ticks are a no-op.
    () => reconcileBuilderPodGc(),
  ]
}

/**
 * Background reconciliation loop. Owns stale-session
 * reaping, opencode first-message capture, and the proxy
 * ssh-agent key heal.
 * Starts with an immediate tick,
 * then ticks once per `intervalMs`. Exits promptly when `signal` aborts;
 * does not interrupt an in-flight tick.
 */
export async function startBackgroundLoop(deps: BackgroundLoopDeps): Promise<void> {
  const { signal } = deps
  const intervalMs = deps.intervalMs ?? 5000
  const sleep = deps.sleep ?? defaultSleep
  const steps = deps.tickSteps ?? defaultTickSteps()

  const runTick = async (): Promise<void> => {
    // One lazily-fetched listing snapshot shared by every step in this
    // tick — the steps that need pods/jobs/vclusters all read the same
    // kubectl list instead of each running their own.
    const snapshot = createTickSnapshot()
    for (const step of steps) {
      // Bail out of the tick as soon as shutdown signals. A step that's
      // already in flight still runs to completion — that's the point of
      // the shutdown's bounded `Promise.race` — but we don't start another
      // one after abort, which keeps shutdown from piling up podman-bound
      // work behind a signal the server has already seen.
      if (signal.aborted) return
      try {
        await step(snapshot)
      } catch (err) {
        serverLog(`[server] loop step ${step.name || 'anon'} failed: ${String(err)}`)
      }
    }
    if (deps.onTick) {
      try {
        await deps.onTick()
      } catch (err) {
        serverLog(`[server] loop onTick failed: ${String(err)}`)
      }
    }
  }

  await runTick()
  while (!signal.aborted) {
    await sleep(intervalMs, signal)
    if (signal.aborted) break
    await runTick()
  }
}
