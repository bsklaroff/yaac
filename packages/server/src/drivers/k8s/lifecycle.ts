import {
  ClusterCache,
  ensurePriorityClasses,
  kubectlApply,
  setActiveClusterCache,
  type WorkspaceDeltaSource,
} from '#drivers/k8s/substrate'
import {
  buildProxyEgressNpManifest,
  buildServerIngressNpManifest,
  ensureMainRegistry,
  ensureNamespace,
  nodeIpBlocks,
} from '#drivers/k8s/cluster'
import {
  PortDetectorManager,
  stopAllWorkspaceForwarders,
} from '#drivers/k8s/forwarders'
import { proxyClient } from '#drivers/k8s/egress'
import { runtimeHandleFromPod } from '#drivers/k8s/workspaces'
import { notifyWorkspaceListChanged } from '#notify'
import { serverLog } from '#log'
import {
  fanOutClaudePlaceholders,
  fanOutCodexPlaceholders,
  loadClaudeCredentialsFile,
  loadCodexCredentialsFile,
} from '@yaac/shared/tool-auth'
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

export type K8sTrigger = typeof K8S_TRIGGERS[number]

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

/**
 * Rewrite the per-project credential files with placeholders.
 *
 * A containerless server writes real OAuth tokens into
 * `projects/<slug>/{claude,codex}`, and those are the files a workspace pod
 * hostPath-mounts. If a data dir once run containerless is served by k8s,
 * sandboxed pods would see real tokens. Re-seeding at every k8s start
 * closes that window. On an install that never ran containerless this
 * rewrites the same placeholders.
 */
async function reseedPlaceholderCredentials(): Promise<void> {
  const claude = await loadClaudeCredentialsFile()
  if (claude?.kind === 'oauth') await fanOutClaudePlaceholders(claude.claudeAiOauth)
  const codex = await loadCodexCredentialsFile()
  if (codex?.kind === 'oauth') await fanOutCodexPlaceholders(codex.codexOauth)
}

/** See `WorkspaceDriver.start`. */
export async function startK8sDriver(sinks: DriverSinks): Promise<void> {
  // Before any pod can launch and mount the files.
  await reseedPlaceholderCredentials()
    .catch((err: unknown) => serverLog(`[server] placeholder re-seed failed: ${String(err)}`))

  // Best-effort cluster bootstrap. Failures are logged, not fatal: the
  // server can serve project/auth RPCs without a cluster, and workspace
  // creation reports RUNTIME_UNAVAILABLE on its own. Awaited so the
  // namespace exists before anything applies into it.
  await (async () => {
    await ensureNamespace()
    // Every pod yaac creates names a priority class, and an older cluster
    // may lack them. Must run before the registry, whose pod names one and
    // would otherwise be rejected (`cluster install` uses the same order).
    await ensurePriorityClasses()
    // A healthy registry costs one HTTP ping here.
    await ensureMainRegistry()
    // Re-render the node part of the server's ingress policy from the
    // live node list (docs/server-in-cluster.md). Install applies it too,
    // but nodes can be added later, and a server pod rescheduled onto a
    // new node must admit that node's kubelet or it never goes Ready.
    const nodeCidrs = await nodeIpBlocks()
    await kubectlApply(buildServerIngressNpManifest(nodeCidrs))
    // The proxy's egress policy, from the same node list. The proxy's own
    // bootstrap skips an already-current proxy, so this is also applied on
    // every server start.
    await kubectlApply(buildProxyEgressNpManifest(nodeCidrs))
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
