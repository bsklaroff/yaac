import { formatCheckResult, runClusterCheck } from '@yaac/server/drivers/k8s/cluster/check'

/**
 * `yaac cluster check` — verify the kubernetes backend's prerequisites
 * (kubectl, cluster, registry, namespace, hostPath/registry wiring) and
 * print actionable fixes for anything broken. Exits 1 on hard failures.
 */
export async function clusterCheck(): Promise<void> {
  const { ok, results } = await runClusterCheck()
  for (const r of results) {
    console.log(formatCheckResult(r))
  }
  if (!ok) {
    console.error('\nCluster is not ready for yaac worktrees. Fix the failures above and re-run.')
    process.exitCode = 1
  } else {
    console.log('\nCluster is ready for yaac worktrees.')
  }
}
