import {
  buildGlobalPvManifest,
  buildGlobalPvcManifest,
  buildServerLocalPvManifest,
  buildServerLocalPvcManifest,
  deleteStorageVolumes,
} from '@yaac/server/drivers/k8s/install/storage'
import { k8sNamespace, kubectlApply, kubectlGetJson } from '@yaac/server/drivers/k8s/substrate'
import { globalRoot, nodeLocalRoot, serverLocalRoot } from '@yaac/shared/paths'
import fs from 'node:fs/promises'

/**
 * The claim pair an install's namespace carries, rendered for a test
 * file's own data dir the way install renders it for the real one
 * (docs/server-in-cluster.md "The e2e tiers run against this"): static
 * PVs into `<dataDir>/global` and `<dataDir>/server-local`, named by the
 * data dir's hash so files never fight over a volume, and bound in the
 * file's `TEST_NAMESPACE`.
 *
 * Needed by every k8s-tier file whose server launches a worktree pod,
 * because the resolver turns every global mount into a subPath of
 * `yaac-global`, and a claim that is not there leaves the pod Pending.
 * `deployTestServer` calls it for every deployed server; a file that
 * creates pods from an in-process server would call it itself.
 */
export async function ensureTestStorageClaims(): Promise<void> {
  for (const dir of [globalRoot(), serverLocalRoot(), nodeLocalRoot()]) {
    await fs.mkdir(dir, { recursive: true })
  }
  await kubectlApply(buildGlobalPvManifest({ hostPath: globalRoot() }))
  await kubectlApply(buildServerLocalPvManifest({ hostPath: serverLocalRoot() }))
  await kubectlApply(buildGlobalPvcManifest())
  await kubectlApply(buildServerLocalPvcManifest())
  const deadline = Date.now() + 60_000
  for (const name of ['yaac-global', 'yaac-server-local']) {
    for (;;) {
      const pvc = await kubectlGetJson<{ status?: { phase?: string } }>([
        'get', 'pvc', name, '-n', k8sNamespace(),
      ])
      if (pvc?.status?.phase === 'Bound') break
      if (Date.now() > deadline) {
        throw new Error(`test storage claim ${name} never bound in ${k8sNamespace()}`)
      }
      await new Promise((r) => setTimeout(r, 250))
    }
  }
}

/**
 * The cluster-scoped half of the pair for one test namespace: PVs do not
 * cascade with the namespace, so the per-file teardown and the global
 * sweep both call this. Never touches the hostPath bytes (`Retain`).
 */
export { deleteStorageVolumes as deleteTestStorageVolumes }
