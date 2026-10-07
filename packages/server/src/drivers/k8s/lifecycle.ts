import {
  ClusterCache,
  setActiveClusterCache,
  type WorkspaceDeltaSource,
} from '#drivers/k8s/substrate'
import { deleteSlugNamedProjectSecrets, ensureMainRegistry } from '#drivers/k8s/cluster'
import {
  PortDetectorManager,
  stopAllWorkspaceForwarders,
} from '#drivers/k8s/forwarders'
import { proxyClient } from '#drivers/k8s/egress'
import { deleteLeakedBuilderPods } from '#drivers/k8s/images'
import { runtimeHandleFromPod } from '#drivers/k8s/workspaces'
import { notifyWorkspaceListChanged } from '#notify'
import { serverLog } from '#log'
import {
  MEDIATOR_TRIGGERS,
  type DriverSinks,
} from '#drivers/contract'

/**
 * Start and stop for the k8s driver: cluster bootstrap, the informer
 * caches and the port detector. It reports upward
 * only through `DriverSinks` (reconcile triggers and the workspace set), so
 * it never imports the layers above (docs/layered-server.md).
 */

/**
 * Every trigger this driver can raise: the mediators' triggers and
 * `proxy-refreshed` (a credential rotation the proxy captured, which the
 * `credential-adopt` step waits on).
 *
 * `ReconcileTrigger` is an open string type, so a misspelled trigger would
 * silently never fire. Raise sites are typed against this list instead.
 */
export const K8S_TRIGGERS = [
  ...MEDIATOR_TRIGGERS,
  'proxy-refreshed',
] as const

type K8sTrigger = typeof K8S_TRIGGERS[number]

/**
 * Map a cluster-cache delta source to a reconcile trigger: pod changes are
 * `workspaces`, Job changes are `units`. The return type makes a renamed
 * trigger a compile error.
 */
export function triggerFor(source: WorkspaceDeltaSource): K8sTrigger {
  return source === 'workspace-pods' ? 'workspaces' : 'units'
}

let clusterCache: ClusterCache | null = null
let portDetector: PortDetectorManager | null = null

/** See `WorkspaceDriver.start`. */
export async function startK8sDriver(sinks: DriverSinks): Promise<void> {
  // Best-effort cluster bootstrap. Failures are logged, not fatal: the
  // server can serve project/auth RPCs without a cluster, and workspace
  // creation reports RUNTIME_UNAVAILABLE on its own. The namespace and the
  // PriorityClasses need no ensure: `cluster install` creates both, and
  // this server runs as a pod in that namespace.
  await (async () => {
    // Before the first build, which a leaked pod's memory reservation
    // could keep from scheduling. Its failure must not skip the rest.
    await deleteLeakedBuilderPods().catch((err: unknown) =>
      serverLog(`[server] leaked builder pod delete failed: ${String(err)}`))
    await deleteSlugNamedProjectSecrets().catch((err: unknown) =>
      serverLog(`[server] slug-named project secrets delete failed: ${String(err)}`))
    // A healthy registry costs one HTTP ping here. The node-address
    // policies are re-rendered by the reconcile pass's node-sync step.
    await ensureMainRegistry()
  })().catch((err) => serverLog(`[server] cluster bootstrap failed: ${String(err)}`))

  // Let the caller restore state the last server left running (such as
  // port forwards) before the watches start, so recovery never races the
  // first deltas.
  try {
    await sinks.recover()
  } catch (err) {
    serverLog(`[server] runtime recovery failed: ${String(err)}`)
  }

  // The informer caches keep the pod cache current, report the workspace
  // set upward, and raise reconcile triggers. The port detector feeds the
  // snapshot's unforwarded ports.
  const cache = new ClusterCache()
  const detector = new PortDetectorManager(() => notifyWorkspaceListChanged())
  clusterCache = cache
  portDetector = detector
  cache.onDelta((source) => {
    // Proxy state only changes the snapshot (e.g. a blocked-host badge).
    if (source === 'proxy-state') {
      notifyWorkspaceListChanged()
      return
    }
    if (source === 'proxy-refreshed') {
      sinks.trigger('proxy-refreshed')
      return
    }
    if (source === 'workspace-pods') {
      const pods = cache.workspacePods()
      sinks.workspacesChanged(pods.map(runtimeHandleFromPod))
      detector.sync(pods)
      // Pod phase reaches clients without a row write, so notify here.
      notifyWorkspaceListChanged()
    }
    sinks.trigger(triggerFor(source))
  })
  cache.start()
  setActiveClusterCache(cache)
  // In the background: it waits on a rollout, and nothing here needs it.
  void proxyClient.rollIfStale()
    .catch((err: unknown) => serverLog(`[server] proxy redeploy failed: ${String(err)}`))

  sinks.attached()
}

/** See `WorkspaceDriver.stop`. */
export function stopK8sDriver(): void {
  // The watches and the port detector's per-workspace execs would
  // otherwise outlive the server.
  setActiveClusterCache(null)
  clusterCache?.stop()
  clusterCache = null
  portDetector?.stopAll()
  portDetector = null
}

/** See `WorkspaceDriver.release`. */
export function releaseK8sDriver(): void {
  // Forget forward declarations and the proxy client's cached state. Runs
  // after the reconcile drain, since a reap can still tear a workspace's
  // forwards down. The deployed proxy stays up for the next server.
  stopAllWorkspaceForwarders()
  proxyClient.disconnect()
}
