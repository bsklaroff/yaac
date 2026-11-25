import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll } from 'vitest'
import { TEST_NAMESPACE } from '@yaac/test-utils/setup'
import { deleteTestServerClusterRbac } from '#support/deployed-server'
import { deleteStorageVolumes } from '@yaac/server/drivers/k8s/install/storage'
import { setWorkspaceDriver } from '@yaac/server/drivers/driver'
import { createK8sDriver } from '@yaac/server/drivers/k8s'
import { acquireNodeShared } from '#support/node-lock'

const execFileAsync = promisify(execFile)

/**
 * Register the real k8s driver. e2e servers register their own at startup,
 * but a file that calls domain code in process (the prewarm suite lists
 * projects) reaches the driver without one.
 */
setWorkspaceDriver(createK8sDriver())

/**
 * Hold the node lock shared for the whole file, so a case that disturbs the
 * whole node (it takes the lock exclusive) never runs beside this file's
 * pods. Registered before the file's own hooks, so it is held across them.
 */
let releaseNode: (() => Promise<void>) | null = null
beforeAll(async () => {
  releaseNode = await acquireNodeShared()
})

/**
 * Delete this file's test namespace (see `TEST_NAMESPACE`) as soon as the
 * file finishes. A workspace-backed file leaves a netd DaemonSet and a proxy
 * Deployment in it; kept until the end of the run, a dozen of them would
 * compete with the files still running.
 *
 * Best-effort and non-blocking; `test/global-setup.ts` sweeps whatever an
 * interrupted file leaves, plus the cluster-scoped objects it owns.
 */
/**
 * Have this file's mountd release its pods' node-mounts directories
 * while it still runs: once the namespace goes, mountd goes with it, and
 * a mount it never undid stays in the node's mount table
 * (docs/generic-workspace-pods.md "Release"). Its workspace pods are
 * deleted at once, then mountd's root is waited on until it is empty.
 */
async function releaseNodeMounts(): Promise<void> {
  await execFileAsync('kubectl', [
    'delete', 'jobs,pods', '-n', TEST_NAMESPACE, '-l', 'yaac.workspace-id',
    '--grace-period=0', '--force', '--ignore-not-found', '--wait=false',
  ], { timeout: 60_000 }).catch(() => {})
  for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
    const left = await execFileAsync('kubectl', [
      'exec', '-n', TEST_NAMESPACE, 'ds/yaac-mountd', '-c', 'mountd', '--', 'ls', '-A', '/node-mounts-root',
    ], { timeout: 15_000 }).then((r) => r.stdout.trim(), () => '')
    if (left === '') return
    await new Promise((r) => setTimeout(r, 1_000))
  }
}

afterAll(async () => {
  await releaseNodeMounts()
  // Cluster-scoped objects don't go with the namespace, so delete the
  // server's ClusterRole/Binding and the storage PVs explicitly.
  await deleteTestServerClusterRbac(TEST_NAMESPACE)
  await deleteStorageVolumes(TEST_NAMESPACE)
  try {
    await execFileAsync(
      'kubectl',
      ['delete', 'namespace', TEST_NAMESPACE, '--ignore-not-found', '--wait=false'],
      { timeout: 30_000 },
    )
  } catch { /* kubectl or cluster absent */ }
  await releaseNode?.()
})
