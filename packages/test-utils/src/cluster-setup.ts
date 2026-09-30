import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll } from 'vitest'
import { TEST_NAMESPACE } from './setup'
import { deleteTestServerClusterRbac } from './deployed-server'
import { deleteTestStorage } from './storage-claims'
import { installRealWorkspaceDriver } from './real-driver'

const execFileAsync = promisify(execFile)

/**
 * Register the real k8s driver. e2e servers register their own at startup,
 * but api tests build the app in-process (`buildApp`), skipping the
 * composition root, so nothing else would.
 */
installRealWorkspaceDriver()

/**
 * Create the install namespace, which the composition root would otherwise
 * ensure. Routes that apply objects (e.g. a project's secrets) need it.
 */
beforeAll(async () => {
  try {
    await execFileAsync('kubectl', ['create', 'namespace', TEST_NAMESPACE], { timeout: 30_000 })
  } catch (err) {
    // Already exists, or there is no cluster.
    if (!/AlreadyExists|already exists/.test(String(err))) return
  }
})

/**
 * Delete this file's test namespace (see `TEST_NAMESPACE`) as soon as the
 * file finishes. A workspace-backed file leaves a netd DaemonSet and a proxy
 * Deployment in it; kept until the end of the run, a dozen of them would
 * compete with the files still running.
 *
 * Best-effort and non-blocking; `test/global-setup.ts` sweeps whatever an
 * interrupted file leaves, plus netd's cluster-scoped RBAC.
 */
afterAll(async () => {
  // Cluster-scoped objects don't go with the namespace, so delete the
  // server's ClusterRole/Binding and the storage PVs explicitly.
  await deleteTestServerClusterRbac(TEST_NAMESPACE)
  await deleteTestStorage(TEST_NAMESPACE)
  try {
    await execFileAsync(
      'kubectl',
      ['delete', 'namespace', TEST_NAMESPACE, '--ignore-not-found', '--wait=false'],
      { timeout: 30_000 },
    )
  } catch { /* kubectl or cluster absent */ }
})
