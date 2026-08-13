import { setWorktreeDriver } from '@yaac/server/drivers/driver'
import { createK8sDriver } from '@yaac/server/drivers/k8s'

/**
 * Register the REAL k8s runtime, for tests that mean to exercise a mediator
 * and the driver together with only the process boundary (kubectl, the
 * stream relay) mocked out.
 *
 * Deliberately its own module: importing it pulls in the whole k8s driver
 * and, with it, `@kubernetes/client-node` — seconds of import time per test
 * file. Tests that only need a mediator want `fake-runtime` instead, which
 * costs nothing.
 */
export function installRealWorktreeDriver(): void {
  setWorktreeDriver(createK8sDriver())
}
