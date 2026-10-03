import fs from 'node:fs/promises'
import path from 'node:path'
import { deleteStorageVolumes, ensureStorageClaims } from '@yaac/server/drivers/k8s/install/storage'
import {
  LABEL_INSTALL_NAMESPACE,
  applyObject,
  dataDirHash,
  deleteObjects,
  k8sNamespace,
  processIdentity,
} from '@yaac/server/drivers/k8s/substrate'
import { globalRoot, nodeLocalRoot, serverLocalRoot } from '@yaac/shared/paths'
import { kindByoLayout, testBackend } from '#kind-byo-layout'
import { localPathClass, nfsClass } from '#kind-byo'

/**
 * Create the install's storage claims in the file's `TEST_NAMESPACE`, for
 * the file's own data dir, using the install code
 * (docs/server-in-cluster.md "The e2e tiers run against this"). Without
 * them a workspace pod stays Pending. `deployTestServer` calls this.
 *
 * On kind: hostPath volumes into `<dataDir>/global` and
 * `<dataDir>/server-local`, named by the data dir's hash.
 *
 * On kind-byo: storage classes of the file's own, built like kind-byo's but
 * pointed at the same two folders. Host-side reads and writes keep working,
 * while pods go through NFS or the block class.
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
  // Classes are cluster-scoped; the label lets the sweep find them.
  const labelled = (cls: Record<string, unknown>): Record<string, unknown> => ({
    ...cls,
    metadata: { ...(cls.metadata as object), labels: testClassLabels() },
  })
  await applyObject(labelled(nfsClass(rwx, path.relative(root, globalRoot()))))
  await applyObject(labelled(localPathClass(rwo, root, path.relative(root, serverLocalRoot()), false)))
  const installId = `test-${dataDirHash()}`
  // The volume roots are this host's tiers, which already hold files (e.g.
  // the host log). Mark them as this install's, or the binder would refuse
  // them as another install's.
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
 * Delete a file's cluster-scoped storage objects (volumes, and on kind-byo
 * its classes), which don't go with the namespace. The data is kept
 * (`Retain`).
 */
export async function deleteTestStorage(installNamespace: string): Promise<void> {
  await deleteStorageVolumes(installNamespace)
  await deleteObjects('storage.k8s.io/v1', 'StorageClass', {
    labelSelector: `${LABEL_INSTALL_NAMESPACE}=${installNamespace}`,
  }).catch(() => { /* cluster gone — nothing to sweep */ })
}
