import { ensurePrewarmSessions, clearFailedPrewarmSessions } from '@/lib/prewarm'
import { reconcileStaleSessions } from '@/lib/session/list'
import { persistAllBlockedHosts } from '@/lib/session/blocked-hosts'
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
    clearFailedPrewarmSessions,
    ensurePrewarmSessions,
    reconcileStaleSessions,
    persistAllBlockedHosts,
  ]
}

/**
 * Background reconciliation loop. Owns prewarm upkeep, stale-session
 * reaping, and blocked-host persistence. Starts with an immediate tick,
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
  }

  await runTick()
  while (!signal.aborted) {
    await sleep(intervalMs, signal)
    if (signal.aborted) break
    await runTick()
  }
}
