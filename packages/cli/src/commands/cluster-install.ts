import { formatCheckResult } from '@yaac/shared/checks'
import {
  runClusterCheck,
  runClusterInstall,
  type ClusterInstallArgs,
} from '@yaac/server/drivers/k8s/install'

/**
 * `yaac cluster install`: converge the machine and cluster, then verify with
 * a cluster check. A step that cannot proceed throws (ClusterInstallError
 * carries the fix); a failed check exits 1.
 */
export async function clusterInstall(options: ClusterInstallArgs): Promise<void> {
  await runClusterInstall(options)

  console.log('\nVerifying with cluster check...')
  const { ok, results } = await runClusterCheck()
  for (const r of results) console.log(formatCheckResult(r))
  if (ok) {
    console.log('\nCluster is ready for yaac sessions.')
    return
  }
  process.exitCode = 1
  console.log('\nCluster is not ready — fix the failures above and re-run `yaac cluster install`.')
  // The layers are already applied, so the cluster looks usable. A failed
  // `egress` gate means NetworkPolicy is not enforced: workspaces still
  // work, but the proxy allowlist covers only redirected ports. Warn
  // loudly, since nothing else would show it.
  if (results.some((r) => r.name === 'egress' && r.status === 'fail')) {
    console.log(
      '\nThe egress gate FAILED, and the install is already in place. Do not start '
      + 'sessions until a re-run passes: this cluster is not enforcing the session '
      + 'NetworkPolicy, so their egress lockdown is advisory and the proxy allowlist '
      + 'covers only the ports the redirect steers.',
    )
  }
}
