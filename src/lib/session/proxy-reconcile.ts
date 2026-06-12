import { proxyClient } from '@/lib/container/proxy-client'
import { daemonLog } from '@/daemon/log'

/**
 * Heal the proxy's ssh-agent after a pod replacement. Session
 * registrations survive churn on their own (the proxy write-throughs
 * them to /data and reloads at boot), but agent identities are
 * deliberately memory-only — key bytes never touch the proxy filesystem
 * — so a replaced pod always boots with an empty agent and only the
 * daemon can re-upload the keys. This is the one proxy heal left on the
 * background tick: session identity is now a per-connection relay token
 * the proxy verifies statelessly, so it needs no healing.
 */
export async function reconcileProxySshKeys(): Promise<void> {
  // attachIfRunning, not ensureRunning: this step must never bootstrap
  // the proxy (it deploys lazily on the first session create), and
  // cleanup paths rely on the same no-side-effects contract.
  if (!(await proxyClient.attachIfRunning())) return
  try {
    await proxyClient.reconcileSshKeys()
  } catch (err) {
    daemonLog(
      '[daemon] proxy-reconcile: ssh-agent key heal failed: '
      + (err instanceof Error ? err.message : String(err)),
    )
  }
}
