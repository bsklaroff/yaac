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
  relabelLegacyWorkspaces,
} from '#drivers/k8s/cluster'
import {
  PortDetectorManager,
  stopAllWorkspaceForwarders,
} from '#drivers/k8s/forwarders'
import {
  PROXY_CHANGE_SOURCES,
  ProxyEventStream,
  proxyClient,
} from '#drivers/k8s/egress'
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
  type ReconcileTrigger,
} from '#drivers/contract'

/**
 * The k8s driver's own attach and detach: the informer caches, the port
 * detector, the proxy event stream, the cluster bootstrap and the host
 * upkeep that only make sense for this substrate.
 *
 * All of it used to sit in the composition root, which was tolerable while
 * there was one driver and no seam to put it behind. It reports upward
 * through `DriverSinks` alone — a trigger for the pass, the workspace set
 * for the machinery's status watchers — so nothing here names the layers
 * that consume it (docs/layered-server.md).
 */

/**
 * Every trigger this driver can raise: what the mediators name, plus its
 * own sources — the proxy's queue edge, and a rotation the proxy captured
 * (`proxy-refreshed`, which the mediators' `credential-adopt` step
 * declares).
 *
 * `ReconcileTrigger` is deliberately open-ended so a driver can watch
 * things the layers above have no word for — the cost of which is silent
 * (a step declaring a trigger nothing raises simply waits out the resync),
 * so the raise sites are typed against this list.
 */
export const K8S_TRIGGERS = [
  ...MEDIATOR_TRIGGERS,
  ...PROXY_CHANGE_SOURCES,
  'proxy-refreshed',
] as const

export type K8sTrigger = typeof K8S_TRIGGERS[number]

/**
 * The substrate's own delta sources, said in the vocabulary a pass
 * schedules on: a pod is a workspace and a Job is the unit holding one.
 *
 * The return type is what makes the translation checkable: rename a
 * mediator trigger in the contract and these two literals stop compiling,
 * rather than producing an edge no step answers.
 */
export function triggerFor(source: WorkspaceDeltaSource): K8sTrigger {
  return source === 'workspace-pods' ? 'workspaces' : 'units'
}

let clusterCache: ClusterCache | null = null
let portDetector: PortDetectorManager | null = null
let proxyEvents: ProxyEventStream | null = null

/**
 * Put the per-project credential files back to placeholders.
 *
 * The one thing a driver flip leaves behind. A containerless server writes
 * REAL OAuth bundles into `projects/<slug>/{claude,codex}` — correctly,
 * since nothing would swap a sentinel there — and those are the very files a
 * workspace pod hostPath-mounts. Pods outlive the server, so a data dir
 * switched back to k8s can have live sandboxed workspaces holding real
 * tokens, which is the one regression class the split otherwise avoids.
 *
 * Re-seeding on attach makes that window bounded rather than open-ended: it
 * closes at the next k8s server start instead of at the next create in each
 * affected project. Idempotent and best-effort — on an install that never
 * ran containerless it rewrites the same placeholders it already had.
 */
async function reseedPlaceholderCredentials(): Promise<void> {
  const claude = await loadClaudeCredentialsFile()
  if (claude?.kind === 'oauth') await fanOutClaudePlaceholders(claude.claudeAiOauth)
  const codex = await loadCodexCredentialsFile()
  if (codex?.kind === 'oauth') await fanOutCodexPlaceholders(codex.codexOauth)
}

/** See `WorkspaceDriver.start`. */
export async function startK8sDriver(sinks: DriverSinks): Promise<void> {
  // Before anything can launch a pod that would mount them: a data dir this
  // server is adopting may have been run containerless, which leaves real
  // credentials in the files every pod mounts (see above).
  await reseedPlaceholderCredentials()
    .catch((err: unknown) => serverLog(`[server] placeholder re-seed failed: ${String(err)}`))

  // Best-effort cluster bootstrap: the yaac namespace and the in-cluster
  // registry are cheap to ensure and needed by the first workspace.
  // Failures are logged, not fatal — the server can serve project/auth
  // RPCs without a cluster, and workspace creation surfaces its own
  // RUNTIME_UNAVAILABLE with a pointer to `yaac cluster check`. Awaited
  // (unlike the fire-and-forget GCs) so the namespace exists before
  // anything applies into it.
  await (async () => {
    await ensureNamespace()
    // Before the informers below, which would otherwise not see a
    // workspace an older install left running (docs/legacy-compat-shims.md).
    const upgrading = await relabelLegacyWorkspaces()
    // Cluster-scoped and idempotent, like the RuntimeClasses `cluster
    // setup` installs — re-ensured here because every pod yaac creates
    // names one, and a cluster set up by an older yaac has neither.
    //
    // STRICTLY before the registry: its Deployment's pod names the infra
    // class, and a pod naming a class the apiserver does not have is
    // rejected — so on the very cluster this re-ensure exists for, the
    // rollout would wait out its full timeout, throw, and abort this
    // chain before ever installing the classes. `cluster install` orders
    // these the same way.
    await ensurePriorityClasses()
    // The registry stands itself up only when it isn't already answering,
    // so a healthy install pays one HTTP ping here.
    await ensureMainRegistry()
    // The node half of this server's own ingress wall, re-rendered from
    // the live node list (docs/server-in-cluster.md). Install applies it
    // too, but the node set is the one input that changes under a running
    // install: a pod rescheduled onto a node added since must admit that
    // node's kubelet itself, or it never goes Ready. The fronting half is
    // install's alone — the server never learns what fronts its Service,
    // and it never rolls its own Deployment for the same reason.
    const nodeCidrs = await nodeIpBlocks()
    await kubectlApply(buildServerIngressNpManifest(nodeCidrs))
    // The proxy's egress, which keeps its upstream dials off the kind
    // fronting's node port, from the same node list. Here as well as in the
    // proxy's bootstrap because that bootstrap is skipped for a proxy that
    // is already current — every install whose proxy predates the policy —
    // and this runs on every server start, which `cluster install` causes.
    await kubectlApply(buildProxyEgressNpManifest(nodeCidrs))
    // Roll the older install's proxy now rather than on the next create:
    // it selects on the old label and speaks the old wire names.
    if (upgrading) await proxyClient.ensureRunning()
  })().catch((err) => serverLog(`[server] cluster bootstrap failed: ${String(err)}`))

  // The substrate is usable and nothing is watching yet — the caller's
  // moment to rebuild what the last server left running (the port
  // forwarders, whose registry a restart drops while the pods keep their
  // tmux bar advertising them). Before the watches on purpose, so recovery
  // never races the first deltas.
  try {
    await sinks.recover()
  } catch (err) {
    serverLog(`[server] runtime recovery failed: ${String(err)}`)
  }

  // Push-fed workspace state: the informer caches keep the display path's
  // pod cache current, report the workspace set upward (the status
  // watchers ride it), and feed the pass's delta triggers. Pod deltas fire
  // a change notification, so snapshots push the moment state changes.
  const cache = new ClusterCache()
  // Detected-listener streams (streamd `ports` pushes) feeding the
  // snapshot's unforwardedPorts; a set change pushes a fresh snapshot.
  const detector = new PortDetectorManager(() => notifyWorkspaceListChanged())
  clusterCache = cache
  portDetector = detector
  cache.onDelta((source) => {
    // The proxy's records are a snapshot input (a blocked host is a badge,
    // never reconcile work); a rotation it captured is what the mediators'
    // `credential-adopt` step is waiting for.
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
      // Reported as contract vocabulary: mapping a pod into one is this
      // driver's own boundary mapper, and nothing above it should ever see
      // a pod.
      sinks.workspacesChanged(pods.map(runtimeHandleFromPod))
      detector.sync(pods)
      // The cache is itself a snapshot input (pod phase reaches clients
      // without any row write), so its delta handler is its mutation site.
      notifyWorkspaceListChanged()
    }
    sinks.trigger(triggerFor(source))
  })
  // The proxy's change stream: the yaac-mama queue edge, which dirties a
  // pass.
  const events = new ProxyEventStream((source: ReconcileTrigger) => sinks.trigger(source))
  proxyEvents = events
  cache.start()
  events.start()
  setActiveClusterCache(cache)

  sinks.attached()
}

/** See `WorkspaceDriver.stop`. */
export function stopK8sDriver(): void {
  // The informer watches hold open apiserver connections, and every
  // per-workspace control-mode exec is a long-lived kubectl process that
  // would otherwise outlive the server (orphaned to PID 1).
  setActiveClusterCache(null)
  clusterCache?.stop()
  clusterCache = null
  portDetector?.stopAll()
  portDetector = null
  // The held-open /events request keeps its exec relay (and the kubectl
  // child behind it) alive, exactly like the watches above.
  proxyEvents?.stop()
  proxyEvents = null
}

/** See `WorkspaceDriver.release`. */
export function releaseK8sDriver(): void {
  // Every active port-forwarder owns a listener server and a set of live
  // relay streams; without this the listeners survive the server
  // (orphaned to PID 1) and the next server stacks new ones on top via
  // the forwarder restore. After the reconcile drain, because a reap tick
  // still tears its workspace's forwards down.
  stopAllWorkspaceForwarders()
  // The proxy client forgets that it verified the deployment; the deployed
  // proxy itself stays up for the next server to adopt.
  proxyClient.disconnect()
}
