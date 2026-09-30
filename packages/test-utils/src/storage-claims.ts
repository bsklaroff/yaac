import fs from 'node:fs/promises'
import path from 'node:path'
import { deleteStorageVolumes, ensureStorageClaims } from '@yaac/server/drivers/k8s/install/storage'
import {
  LABEL_INSTALL_NAMESPACE,
  dataDirHash,
  k8sNamespace,
  kubectlApply,
  kubectlWithRetry,
  processIdentity,
} from '@yaac/server/drivers/k8s/substrate'
import { globalRoot, nodeLocalRoot, serverLocalRoot } from '@yaac/shared/paths'
import { kindByoLayout, testBackend } from '#kind-byo-layout'
import { localPathClass, nfsClass } from '#kind-byo'

/**
 * The claim pair an install's namespace carries, bound for a test file's
 * own data dir by the code install runs (docs/server-in-cluster.md "The
 * e2e tiers run against this"), and bound in the file's `TEST_NAMESPACE`.
 *
 * On the kind rig that is the static shape: hostPath volumes into
 * `<dataDir>/global` and `<dataDir>/server-local`, named by the data dir's
 * hash so files never fight over a volume.
 *
 * On kind-byo it is the class shape — the code a byo install runs — through
 * a pair of classes of the file's own, built the way kind-byo's are: the
 * NFS class's fixed `subDir` and the local-path class's fixed pattern put
 * the two volumes at exactly the same two folders. So every host-side read
 * and write a file makes of its tiers keeps working unchanged, while every
 * byte a pod sees goes through NFS or the provisioned block class. (Unlike
 * kind-byo's own classes, which give each claim a directory of its own.)
 *
 * Needed by every k8s-tier file whose server launches a workspace pod,
 * because the resolver turns every global mount into a subPath of
 * `yaac-global`, and a claim that is not there leaves the pod Pending.
 * `deployTestServer` calls it for every deployed server, handing it the
 * server image for the class path's binder pod.
 */
export async function ensureTestStorageClaims(binderImage: string): Promise<void> {
  if (testBackend() === 'kind') {
    await ensureStorageClaims({
      shape: {
        kind: 'static',
        globalHostPath: globalRoot(),
        serverLocalHostPath: serverLocalRoot(),
        nodeLocalHostPath: nodeLocalRoot(),
      },
    })
    return
  }
  const root = kindByoLayout().dataDir
  const rwx = `yaac-test-nfs-${dataDirHash()}`
  const rwo = `yaac-test-local-${dataDirHash()}`
  // Cluster-scoped, so labelled with the install namespace like the
  // volumes, and swept with them.
  const labelled = (cls: Record<string, unknown>): Record<string, unknown> => ({
    ...cls,
    metadata: { ...(cls.metadata as object), labels: testClassLabels() },
  })
  await kubectlApply(labelled(nfsClass(rwx, path.relative(root, globalRoot()))))
  await kubectlApply(labelled(localPathClass(rwo, root, path.relative(root, serverLocalRoot()), false)))
  // One file, one install: its data dir is its own, so its hash is an id.
  const installId = `test-${dataDirHash()}`
  // The two volume roots ARE this host's tiers, which the file has been
  // writing into (its host log, for one) before the binder runs — so it
  // claims them for its install the way the binder would, or the binder
  // would take that content for another install's and refuse the root.
  for (const tier of [globalRoot(), serverLocalRoot()]) {
    await fs.mkdir(tier, { recursive: true })
    await fs.writeFile(path.join(tier, '.yaac-install'), installId)
  }
  await ensureStorageClaims({
    shape: { kind: 'classes', rwx, rwo, identity: processIdentity(), installId, binderImage },
  })
}

function testClassLabels(): Record<string, string> {
  return { app: 'yaac-server', [LABEL_INSTALL_NAMESPACE]: k8sNamespace() }
}

/**
 * The cluster-scoped half of a file's storage: its volumes, and on
 * kind-byo its classes. Neither cascades with the namespace, so the
 * per-file teardown and the global sweep both call this. Never touches
 * the bytes (`Retain`).
 */
export async function deleteTestStorage(installNamespace: string): Promise<void> {
  await deleteStorageVolumes(installNamespace)
  await kubectlWithRetry([
    'delete', 'storageclass', '-l', `${LABEL_INSTALL_NAMESPACE}=${installNamespace}`,
    '--ignore-not-found', '--wait=false',
  ], { timeout: 30_000, maxAttempts: 1 }).catch(() => { /* cluster gone — nothing to sweep */ })
}
