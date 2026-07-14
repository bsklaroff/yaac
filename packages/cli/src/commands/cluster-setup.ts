import { ClusterSetupError, runClusterSetup } from '@yaac/server/lib/k8s/cluster-setup'

export interface ClusterSetupCliOptions {
  repair?: boolean
}

/**
 * `yaac cluster setup` — create (or, with --repair, fix up) the local kind
 * cluster yaac runs sessions on. Host-side like `cluster check`: talks to
 * podman/kind/kubectl directly, never to the server. Exits 1 when a step
 * cannot proceed (ClusterSetupError carries the fix instructions) or when
 * the finishing cluster check fails.
 */
export async function clusterSetup(options: ClusterSetupCliOptions = {}): Promise<void> {
  try {
    const ok = await runClusterSetup({ repair: options.repair })
    if (!ok) process.exitCode = 1
  } catch (err) {
    if (err instanceof ClusterSetupError) {
      console.error(`\n${err.message}`)
      process.exitCode = 1
      return
    }
    throw err
  }
}
