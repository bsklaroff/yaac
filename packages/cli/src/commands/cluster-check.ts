import { formatCheckResult } from '@yaac/shared/checks'
import { runClusterCheck } from '@yaac/server/drivers/k8s/install'

/**
 * `yaac cluster check`: verify the k8s driver's prerequisites (kubectl,
 * cluster, registry, namespace, hostPath/registry wiring) and print a fix
 * for anything broken. Exits 1 on hard failures.
 */
export async function clusterCheck(): Promise<void> {
  const { ok, results } = await runClusterCheck()
  for (const r of results) {
    console.log(formatCheckResult(r))
  }
  if (!ok) throw new Error('\nCluster is not ready for yaac workspaces. Fix the failures above and re-run.')
  console.log('\nCluster is ready for yaac workspaces.')
}
