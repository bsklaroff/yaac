import { ClusterInstallError, runClusterInstall } from '@yaac/server/drivers/k8s/install'

export interface ClusterInstallCliOptions {
  /** Raw `--nodes` value; commander hands options through as strings. */
  nodes?: string
  /**
   * `--byo`: install into the kubeconfig's cluster instead of creating one,
   * with storage from the named classes and the server on the tailnet.
   */
  byo?: boolean
  /** `--rwx-storage-class` (commander camelCases the flags). */
  rwxStorageClass?: string
  /** `--rwo-storage-class`. */
  rwoStorageClass?: string
  /**
   * `--tailnet`: publish a kind install's server through the Tailscale
   * operator instead of on this machine's loopback.
   */
  tailnet?: boolean
}

/**
 * `yaac cluster install`: bring this machine and its cluster up to the
 * installed yaac version (kind cluster and CNI if missing, node fixups,
 * built-in images, in-cluster objects). Safe to re-run at any time; nothing
 * here is destructive.
 *
 * Runs on the host against podman/kind/kubectl directly, not through the
 * server. Exits 1 when a step cannot proceed (ClusterInstallError carries the
 * fix instructions) or the final cluster check fails.
 *
 * `--nodes` is passed through unparsed so `runClusterInstall` can report
 * what the user typed rather than `NaN`.
 */
export async function clusterInstall(options: ClusterInstallCliOptions = {}): Promise<void> {
  try {
    const ok = await runClusterInstall({
      nodes: options.nodes,
      byo: options.byo,
      rwxStorageClass: options.rwxStorageClass,
      rwoStorageClass: options.rwoStorageClass,
      tailnet: options.tailnet,
    })
    if (!ok) process.exitCode = 1
  } catch (err) {
    if (err instanceof ClusterInstallError) {
      console.error(`\n${err.message}`)
      process.exitCode = 1
      return
    }
    throw err
  }
}
