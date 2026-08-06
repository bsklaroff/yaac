import { ClusterSetupError, runClusterSetup } from '@yaac/server/features/cluster/setup'

export interface ClusterSetupCliOptions {
  repair?: boolean
  /** Raw `--nodes` value; commander hands options through as strings. */
  nodes?: string
}

/**
 * `yaac cluster setup` — create (or, with --repair, fix up) the local kind
 * cluster yaac runs sessions on. Host-side like `cluster check`: talks to
 * podman/kind/kubectl directly, never to the server. Exits 1 when a step
 * cannot proceed (ClusterSetupError carries the fix instructions) or when
 * the finishing cluster check fails.
 *
 * `--nodes` is passed through as the raw text, not converted here:
 * `runClusterSetup` owns the bounds, and converting first would leave it
 * reporting `NaN` instead of what the user actually typed.
 */
export async function clusterSetup(options: ClusterSetupCliOptions = {}): Promise<void> {
  try {
    const ok = await runClusterSetup({ repair: options.repair, nodes: options.nodes })
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
