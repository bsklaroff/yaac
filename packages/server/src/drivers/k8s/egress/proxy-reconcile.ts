import { proxyClient } from './proxy-client'
import { serverLog } from '#log'

/**
 * Heal what a proxy pod replacement loses: the ssh-agent's identities, and
 * the secret values behind every registration's `secretRef`.
 *
 * Worktree registrations survive churn on their own (the proxy
 * write-throughs them to /data and reloads at boot), but both of these are
 * deliberately memory-only — neither key bytes nor secret values ever touch
 * the proxy filesystem — so a replaced pod always boots without them and
 * only the server can put them back. Without this the injections of every
 * RUNNING worktree stop resolving silently, until some later create for that
 * project happens to push again.
 *
 * Worktree identity needs no healing: it is a per-connection relay token the
 * proxy verifies statelessly.
 */
export async function reconcileProxySshKeys(): Promise<void> {
  // attachIfRunning, not ensureRunning: this step must never bootstrap
  // the proxy (it deploys lazily on the first worktree create), and
  // cleanup paths rely on the same no-side-effects contract.
  if (!(await proxyClient.attachIfRunning())) return
  for (const [what, heal] of [
    ['ssh-agent key', () => proxyClient.reconcileSshKeys()],
    ['secret value', () => proxyClient.reconcileProxySecrets()],
  ] as const) {
    try {
      await heal()
    } catch (err) {
      serverLog(
        `[server] proxy-reconcile: ${what} heal failed: `
        + (err instanceof Error ? err.message : String(err)),
      )
    }
  }
}
