import { reconcileStaleSessions, captureOpencodeFirstMessages } from '@/lib/session/list'
import { reconcileProxySshKeys } from '@/lib/session/proxy-reconcile'
import { reconcileVclusters } from '@/lib/session/vcluster-reconcile'
import { reconcileInnerRedirects } from '@/lib/session/inner-redirect-reconcile'
import { reconcileStaleTproxyRules } from '@/lib/session/tproxy-gc-reconcile'
import { reconcileVclusterAttribution } from '@/lib/session/vcluster-attribution-reconcile'
import { reconcilePrewarmPool } from '@/daemon/prewarm-reconcile'
import { reconcileImagePrewarm } from '@/daemon/image-prewarm'
import { daemonLog } from '@/daemon/log'

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
   * sequence with per-step error isolation. Defaults to the real tick.
   */
  tickSteps?: Array<() => Promise<void>>
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

function defaultTickSteps(): Array<() => Promise<void>> {
  return [
    reconcileStaleSessions,
    // Keep every project's image chain built and pushed (detached tasks, so
    // a minutes-long build never blocks the tick). Before the prewarm pool:
    // a spare's createSession then joins the already-running builds.
    reconcileImagePrewarm,
    // Keep one prewarmed spare per active project (after the stale sweep so
    // counts reflect just-reaped sessions). No-op when the pool size is 0.
    reconcilePrewarmPool,
    captureOpencodeFirstMessages,
    // ssh-agent heal only (attach-only probe, never bootstraps): session
    // registrations survive proxy pod replacement via the /data
    // write-through, but agent identities are memory-only by design and
    // need the daemon to re-upload them. The proxy itself is deployed
    // lazily by the first session create's ensureRunning().
    reconcileProxySshKeys,
    // Per-session vclusters: orphan GC + host-side kubeconfig heal.
    reconcileVclusters,
    // yaac-in-yaac: project the inner egress redirect for a vcluster's synced
    // pods once its inner proxy is up (or prune it when gone).
    reconcileInnerRedirects,
    // yaac-in-yaac: tell the outer proxy which outer session owns each
    // vcluster's pods, so their chained egress is attributed + allowlist-judged
    // (the proxy can't resolve those cross-namespace source pods itself).
    reconcileVclusterAttribution,
    // GC the TPROXY rules Cilium leaks when a CEC is deleted (vcluster
    // churn residue). Throttled internally — most ticks are a no-op. After
    // reconcileInnerRedirects so a CEC it just (re)applied reads as live.
    reconcileStaleTproxyRules,
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
    for (const step of steps) {
      // Bail out of the tick as soon as shutdown signals. A step that's
      // already in flight still runs to completion — that's the point of
      // the shutdown's bounded `Promise.race` — but we don't start another
      // one after abort, which keeps shutdown from piling up podman-bound
      // work behind a signal the daemon has already seen.
      if (signal.aborted) return
      try {
        await step()
      } catch (err) {
        daemonLog(`[daemon] loop step ${step.name || 'anon'} failed: ${String(err)}`)
      }
    }
    if (deps.onTick) {
      try {
        await deps.onTick()
      } catch (err) {
        daemonLog(`[daemon] loop onTick failed: ${String(err)}`)
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
