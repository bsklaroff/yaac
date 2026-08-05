import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll } from 'vitest'
import { TEST_NAMESPACE } from './setup'

const execFileAsync = promisify(execFile)

/**
 * Cluster hygiene for the api/e2e projects — NOT loaded by `unit:*`,
 * which must never touch the cluster (and would pay this module's import
 * graph for nothing).
 *
 * Drops this file's test namespace as soon as the file finishes instead
 * of leaving every one of them to the global teardown. The namespace is
 * per FILE (see `TEST_NAMESPACE`), and a session-backed file leaves a
 * netd DaemonSet and a proxy Deployment running in it. Held to the end of
 * the run, a full suite accumulates a dozen-odd netd pods — each running
 * an Envoy and reconciling the SAME single node's iptables — competing
 * with the files still to come. Deleting here keeps the node's
 * steady-state cost flat across the run rather than growing with the
 * number of files already done.
 *
 * Best-effort and non-blocking (`--wait=false`): `test/global-setup.ts`
 * still sweeps whatever an interrupted or crashed file leaves behind,
 * plus netd's cluster-scoped RBAC, which does not cascade with the
 * namespace. A file that never created the namespace deletes nothing.
 */
afterAll(async () => {
  try {
    await execFileAsync(
      'kubectl',
      ['delete', 'namespace', TEST_NAMESPACE, '--ignore-not-found', '--wait=false'],
      { timeout: 30_000 },
    )
  } catch { /* kubectl or cluster absent — the global teardown still sweeps */ }
})
