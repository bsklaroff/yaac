import { setWorkspaceDriver } from '@yaac/server/drivers/driver'
import { createK8sDriver } from '@yaac/server/drivers/k8s'

/**
 * Register the real k8s driver, for tests that exercise a mediator and the
 * driver together with only the process boundary mocked.
 *
 * Its own module because importing it pulls in the k8s driver and
 * `@kubernetes/client-node`, which take seconds. Tests that only need a
 * mediator should use `#fake-driver`.
 */
export function installRealWorkspaceDriver(): void {
  setWorkspaceDriver(createK8sDriver())
}
