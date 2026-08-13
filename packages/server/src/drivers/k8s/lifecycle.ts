import {
  ClusterCache,
  anyWorktreeDirsExist,
  armDeferredClusterBoot,
  ensurePriorityClasses,
  invalidateRelayAddr,
  setActiveClusterCache,
  VCLUSTER_DELTA_SOURCES,
  type DeltaSource,
} from '#drivers/k8s/substrate'
import {
  ensureMainRegistry,
  ensureNamespace,
  gcOrphanProjectRegistries,
} from '#drivers/k8s/cluster'
import { killTrackedPodmanProcs, reapOrphanedPodmanProcs } from '#drivers/k8s/container'
import {
  PortDetectorManager,
  stopAllWorktreeForwarders,
} from '#drivers/k8s/forwarders'
import {
  PROXY_CHANGE_SOURCES,
  ProxyEventStream,
  configureProxyCredentials,
  proxyClient,
} from '#drivers/k8s/egress'
import { runtimeHandleFromPod } from '#drivers/k8s/view'
import { notifyWorktreeListChanged } from '#notify'
import { serverLog } from '#log'
import {
  fanOutClaudePlaceholders,
  fanOutCodexPlaceholders,
  loadClaudeCredentialsFile,
  loadCodexCredentialsFile,
} from '@yaac/shared/tool-auth'
import { env } from '@yaac/shared/env'
import {
  MEDIATOR_TRIGGERS,
  type DriverDeps,
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
 * own sources, which only its own steps declare.
 *
 * `ReconcileTrigger` is deliberately open-ended so a driver can watch
 * things the layers above have no word for — the cost of which is silent
 * (a step declaring a trigger nothing raises simply waits out the resync),
 * so the raise sites are typed against this list.
 */
export const K8S_TRIGGERS = [
  ...MEDIATOR_TRIGGERS,
  ...VCLUSTER_DELTA_SOURCES,
  ...PROXY_CHANGE_SOURCES,
] as const

export type K8sTrigger = typeof K8S_TRIGGERS[number]

/**
 * The substrate's own delta sources, said in the vocabulary a pass
 * schedules on. Only the two the mediators' steps name are translated: a
 * pod is a workspace and a Job is the unit holding one. The vcluster
 * sources pass through unchanged — they are this driver's own, declared by
 * its own steps, and no layer above has a word for them.
 *
 * The return type is what makes the translation checkable: rename a
 * mediator trigger in the contract and these two literals stop compiling,
 * rather than producing an edge no step answers.
 */
export function triggerFor(source: DeltaSource): K8sTrigger {
  if (source === 'worktree-pods') return 'workspaces'
  if (source === 'worktree-jobs') return 'units'
  return source
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
 * worktree pod hostPath-mounts. Pods outlive the server, so a data dir
 * switched back to k8s can have live sandboxed worktrees holding real
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

async function attachNow(sinks: DriverSinks): Promise<void> {
  // Before anything can launch a pod that would mount them: a data dir this
  // server is adopting may have been run containerless, which leaves real
  // credentials in the files every pod mounts (see above).
  await reseedPlaceholderCredentials()
    .catch((err: unknown) => serverLog(`[server] placeholder re-seed failed: ${String(err)}`))

  // Kill any podman build/push a previous server left running before the
  // first thing that could duplicate it (the registry bootstrap's own
  // podman calls, then the reconciler's prewarm sweep). The graceful path
  // already SIGTERMs them, so this only fires after a crash, a SIGKILL,
  // or a host reboot — the cases builder-pod GC covers on the cluster
  // side via SERVER_START_MS.
  try {
    await reapOrphanedPodmanProcs()
  } catch (err) {
    serverLog(`[server] orphan podman reap failed: ${String(err)}`)
  }

  // Best-effort cluster bootstrap: the yaac namespace and the in-cluster
  // registry are cheap to ensure and needed by the first worktree.
  // Failures are logged, not fatal — the server can serve project/auth
  // RPCs without a cluster, and worktree creation surfaces its own
  // RUNTIME_UNAVAILABLE with a pointer to `yaac cluster check`. Awaited
  // (unlike the fire-and-forget GCs) so a deferred boot's trigger —
  // the first worktree create — sees the namespace exist before it
  // applies anything into it.
  await (async () => {
    await ensureNamespace()
    // Cluster-scoped and idempotent, like the RuntimeClasses `cluster
    // setup` installs — re-ensured here because every pod yaac creates
    // names one, and a cluster set up by an older yaac has neither.
    //
    // STRICTLY before the registry: its Deployment's pod names the infra
    // class, and a pod naming a class the apiserver does not have is
    // rejected — so on the very cluster this re-ensure exists for, the
    // rollout would wait out its full timeout, throw, and abort this
    // chain before ever installing the classes. `cluster setup` orders
    // these the same way.
    await ensurePriorityClasses()
    // The registry stands itself up only when it isn't already answering,
    // so a healthy install pays one HTTP ping here.
    await ensureMainRegistry()
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
  const detector = new PortDetectorManager(() => notifyWorktreeListChanged())
  clusterCache = cache
  portDetector = detector
  cache.onDelta((source) => {
    if (source === 'worktree-pods') {
      const pods = cache.worktreePods()
      // Reported as contract vocabulary: mapping a pod into one is this
      // driver's own boundary mapper, and nothing above it should ever see
      // a pod.
      sinks.workspacesChanged(pods.map(runtimeHandleFromPod))
      detector.sync(pods)
      // The cache is itself a snapshot input (pod phase reaches clients
      // without any row write), so its delta handler is its mutation site.
      notifyWorktreeListChanged()
    }
    sinks.trigger(triggerFor(source))
  })
  // The proxy's change stream: blocked hosts and git-auth failures (snapshot
  // inputs it notifies for itself) plus the spawn queue and the reattach
  // edge, which dirty a pass.
  const events = new ProxyEventStream((source: ReconcileTrigger) => sinks.trigger(source))
  proxyEvents = events
  cache.start()
  events.start()
  setActiveClusterCache(cache)

  // Remove per-project push registries whose project dir is gone —
  // catches `project remove` runs that raced an unavailable cluster.
  void gcOrphanProjectRegistries()
    .catch((err) => serverLog(`[server] orphan registry GC failed: ${String(err)}`))

  sinks.attached()
}

/** See `WorktreeDriver.start`. */
export async function startK8sDriver(sinks: DriverSinks, deps: DriverDeps): Promise<void> {
  // Where the egress path reads credential material from. Wired before any
  // attach, since a deferred one fires from a worktree create — and left
  // unwired when the caller supplies nothing, which degrades to "no ssh
  // injection" rather than clearing what a live proxy is using.
  if (deps.sshIdentities) configureProxyCredentials({ listSshEntries: deps.sshIdentities })

  // A NESTED server's cluster is its worktree's born-at-zero vcluster
  // (docs/vcluster-scale-to-zero.md) — attaching at boot is exactly what
  // would wake it seconds after the create-time sleep, since `yaac
  // server start` runs from the worktree's initCommands. With no
  // worktrees of its own yet, defer every cluster touch until the first
  // real use (worktree create awaits it; any kubectl call kicks it). A
  // RESTARTING nested server with live worktrees attaches eagerly: those
  // worktrees need the caches and reconciler, and their vcluster — this
  // vcluster — is already awake.
  //
  // `sinks.attached` fires with the attach, not with this call: the
  // reconcile loop is convergence too, and starting it against a
  // sleeping vcluster is the same mistake as starting the caches.
  if (env.nested && !(await anyWorktreeDirsExist())) {
    armDeferredClusterBoot(async () => {
      serverLog('[server] nested: first cluster use — attaching (caches, reconciler)')
      await attachNow(sinks)
    })
    serverLog('[server] nested: cluster attach deferred until first use (vcluster stays asleep)')
    return
  }
  await attachNow(sinks)
}

/** See `WorktreeDriver.stop`. */
export function stopK8sDriver(): void {
  // The informer watches hold open apiserver connections, and every
  // per-worktree control-mode exec is a long-lived kubectl process that
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
  // Abort in-flight host builds/pushes. Podman commits an image tag only
  // when the build finishes, so an orphaned `podman build` is invisible
  // to the next server's exists check — it would start a second build of
  // the same tag and the two would fight over the layer cache.
  killTrackedPodmanProcs()
}

/** See `WorktreeDriver.release`. */
export function releaseK8sDriver(): void {
  // Every active port-forwarder owns a listener server and a set of live
  // relay streams; without this the listeners survive the server
  // (orphaned to PID 1) and the next server stacks new ones on top via
  // the forwarder restore. After the reconcile drain, because a reap tick
  // still tears its worktree's forwards down.
  stopAllWorktreeForwarders()
  // Same for the proxy control tunnel and the stream relay's
  // `kubectl port-forward` child — the deployed proxy itself stays up
  // for the next server to adopt.
  proxyClient.disconnect()
  invalidateRelayAddr()
}
