import { ClusterDeleteError, runClusterDelete } from '@yaac/server/drivers/k8s/cluster/delete'

export interface ClusterDeleteCliOptions {
  yes?: boolean
}

/**
 * `yaac cluster delete` — delete the local kind cluster and its registry,
 * keeping on-disk worktrees and worktrees. Host-side like `cluster install`:
 * talks to kind/podman directly, never the server. Exits 1 when a step
 * cannot proceed (ClusterDeleteError carries the fix instructions).
 */
export async function clusterDelete(options: ClusterDeleteCliOptions = {}): Promise<void> {
  try {
    await runClusterDelete({ yes: options.yes })
  } catch (err) {
    if (err instanceof ClusterDeleteError) {
      console.error(`\n${err.message}`)
      process.exitCode = 1
      return
    }
    throw err
  }
}
