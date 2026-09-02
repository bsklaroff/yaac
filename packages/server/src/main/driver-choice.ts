import { recordedDriver } from '@yaac/shared/install-driver'
import { env } from '@yaac/shared/env'
import type { DriverKind } from '@yaac/shared/types'

/**
 * Which substrate an install runs, and how a process knows.
 *
 * **Placement is the driver** (docs/server-in-cluster.md). A server that is
 * a pod of the cluster it manages runs `k8s`; a server that is a process on
 * your machine runs `containerless`. There is no third combination, so
 * there is nothing to choose per start and no flag to choose it with — what
 * a start does is *notice* which of the two it is, and write it down.
 *
 * Writing it down is still load-bearing, because the answer outlives the
 * process that gave it: a CLIENT that cannot reach the server has to know
 * whether the fix is `yaac server start` or `yaac cluster install`. But
 * this process is not what writes it. The record rides in `server.json`
 * beside the origin and token, written by whichever COMMAND stood the
 * server up — `yaac server start` for a host process, `yaac cluster
 * install` for the Deployment — so the one write that points this machine
 * at a server also says what kind of install it is. Reading it back is
 * `recordedDriver` in `@yaac/shared`, where the desktop shell can see it.
 *
 * The crossing that USED to need arbitrating here — a start that moved an
 * install from one substrate to the other, stranding whatever the outgoing
 * one still ran — cannot be expressed any more. `yaac cluster install` is
 * the only way to become a k8s install, and it already refuses to run
 * against a containerless one.
 */

/**
 * The driver this process runs.
 *
 * `YAAC_IN_CLUSTER` is set by the server Deployment's manifest and by
 * nothing else, so it is exactly the question "am I the pod?" — which is
 * exactly the question "which substrate is this". A host process reaching
 * this point is a containerless server by construction;
 * `assertHostServerAllowed` is what stops one being started against a k8s
 * install in the first place.
 *
 * Nothing is written here. The record is CLIENT-LOCAL — not mounted into
 * the pod by design, and not this process's to keep even on a host, where
 * `yaac server run` may be a foreground server the operator drove directly.
 * The command that stood the server up records it (see the module doc).
 */
export function resolveDriverKind(): DriverKind {
  return env.inCluster ? 'k8s' : 'containerless'
}

/**
 * Refuse to start a host server on a data dir whose install runs in the
 * cluster.
 *
 * Two servers on one data dir is two writers of one PGlite database, and
 * the host one would additionally see every worktree as podless and reap
 * it. The recorded driver is the tripwire, and the message names the only
 * command that starts THIS install's server.
 *
 * Run by the PARENT of a detached start as well as by the child: a child
 * that throws dies before its log is wired, so the operator would otherwise
 * wait out the ready poll and be told the server "did not become ready".
 */
export async function assertHostServerAllowed(): Promise<void> {
  if (env.inCluster) return
  if (await recordedDriver() !== 'k8s') return
  throw new Error(
    'This install runs its server in the cluster, so there is no host server '
    + 'to start — starting one would put two writers on this data dir.\n'
    + '    Converge the cluster instead: `yaac cluster install`. '
    + '(`yaac server start|stop|restart` act on the Deployment once it exists.)',
  )
}
