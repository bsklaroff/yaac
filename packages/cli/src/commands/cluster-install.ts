import { ClusterInstallError, runClusterInstall } from '@yaac/server/drivers/k8s/install'

export interface ClusterInstallCliOptions {
  /** Raw `--nodes` value; commander hands options through as strings. */
  nodes?: string
  /** `--byo`: install into a cluster yaac did not create. */
  byo?: boolean
  /** `--rwx-storage-class` (commander camelCases the flags). */
  rwxStorageClass?: string
  /** `--rwo-storage-class`. */
  rwoStorageClass?: string
  /** `--tailnet`: publish the server through the Tailscale operator. */
  tailnet?: boolean
}

/**
 * `yaac cluster install` — converge this machine and its cluster to the
 * yaac version that is installed: the kind cluster and its CNI if there is
 * none yet, the kind node fixups, every built-in image, and the in-cluster
 * layers. Safe to run at any time and after any upgrade; it has no
 * destructive path (`yaac cluster delete` is the only one).
 *
 * Host-side like `cluster check`: talks to podman/kind/kubectl directly,
 * never to the server. Exits 1 when a step cannot proceed
 * (ClusterInstallError carries the fix instructions) or when the finishing
 * cluster check fails.
 *
 * `--nodes` is passed through as the raw text, not converted here:
 * `runClusterInstall` owns the bounds, and converting first would leave it
 * reporting `NaN` instead of what the user actually typed.
 *
 * `--byo` installs into the cluster the kubeconfig points at instead of
 * creating one, provisioning the claims from the named classes and
 * fronting the server on the tailnet. `--tailnet` fronts a kind install's
 * server on the tailnet instead of at this machine's loopback.
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
