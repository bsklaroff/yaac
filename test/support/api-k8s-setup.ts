import { setWorkspaceDriver } from '@yaac/server/drivers/driver'
import { createK8sDriver } from '@yaac/server/drivers/k8s'

/**
 * Register the real k8s driver for the `api-k8s` project. Like
 * `containerless-setup.ts`: api tests build the app in-process (`buildApp`),
 * skipping the composition root that would register one. Its cluster is
 * the fake that `k8s-stub-setup.ts` puts behind `@kubernetes/client-node`,
 * so the project needs no cluster.
 */
setWorkspaceDriver(createK8sDriver())
