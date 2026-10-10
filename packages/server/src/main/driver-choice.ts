import { recordedDriver } from '@yaac/shared/install-record'
import { env } from '@yaac/shared/env'
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- names the data dir in a refusal; builds no path
import { getDataDir } from '@yaac/shared/paths'
import type { DriverKind } from '@yaac/shared/types'

/**
 * Which substrate this server runs (docs/server-in-cluster.md). A server
 * running as a pod of its cluster is `k8s`; a host process is
 * `containerless`. There is no per-start choice.
 *
 * The answer is recorded in the data dir's `install.json` by the command
 * that stood the server up (`yaac server start` or `yaac cluster install`),
 * so a client that cannot reach the server knows which command fixes it.
 * `recordedDriver` in `@yaac/shared` reads it back. `yaac cluster install`
 * refuses a containerless data dir, so an install cannot switch substrates.
 */

/**
 * The driver this process runs. `YAAC_IN_CLUSTER` is set only by the server
 * Deployment, so it means "this is the pod". A host process is containerless;
 * `assertHostServerAllowed` keeps one from starting against a k8s install.
 * Nothing is recorded here (see the module comment).
 */
export function resolveDriverKind(): DriverKind {
  return env.inCluster ? 'k8s' : 'containerless'
}

/**
 * Refuse to start a host server on a data dir whose install runs in the
 * cluster: that would put two writers on one PGlite database, and the host
 * server would reap every workspace as podless.
 *
 * Also run by the parent of a detached start, since a child that throws
 * before its log is wired would otherwise surface only as "did not become
 * ready".
 */
export async function assertHostServerAllowed(): Promise<void> {
  if (env.inCluster) return
  if (await recordedDriver() !== 'k8s') return
  throw new Error(
    `The data dir ${getDataDir()} is a cluster install, whose server runs in the cluster, `
    + 'so there is no host server to start: one would be a second writer of this data dir.\n'
    + '    Start the cluster\'s server with `yaac cluster start`, or point YAAC_DATA_DIR '
    + 'at a data dir of its own for a host server.',
  )
}
