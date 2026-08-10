import {
  ClusterCache,
  anyWorktreeDirsExist,
  armDeferredClusterBoot,
  ensurePriorityClasses,
  invalidateRelayAddr,
  setActiveClusterCache,
  type DeltaSource,
} from '#platform/k8s'
import {
  ensureMainRegistry,
  ensureNamespace,
  gcOrphanProjectRegistries,
} from '#features/cluster'
import { killTrackedPodmanProcs, reapOrphanedPodmanProcs } from '#platform/container'
import { StatusWatcherManager, onLiveAgentsChanged, onWorktreeStatusChanged } from '#features/status'
import {
  PortDetectorManager,
  restoreAllWorktreeForwarders,
  stopAllWorktreeForwarders,
} from '#features/forwarders'
import { proxyClient } from '#features/egress'
import { recordedConversationHandles } from '#features/records'
import { notifyWorktreeListChanged } from '#notify'
import { serverLog } from '#log'
import { env } from '@yaac/shared/env'

/**
 * A change one of the convergence watches saw — the sources that dirty a
 * reconcile pass. Mostly substrate-flavored because the informer is; the
 * one that is not a cache delta is `live-agents`: a worktree's set of
 * running conversations changed, which only an in-pod event (an ACP
 * handshake answering with a session id) can produce.
 */
export type ChangeSource = DeltaSource | 'live-agents'

/**
 * Attaching the server to its substrate, and letting go of it again.
 *
 * Everything convergence-owning starts here — the informer caches, the
 * per-worktree status watchers, the port detector — and stops here, in two
 * stages: `stopConvergence` kills everything push-fed before the reconcile
 * loop drains (the watches hold apiserver connections and a long-lived exec
 * per worktree), and `releaseConvergence` lets go of what was borrowed from
 * the host (port forwarders, the proxy control tunnel) after the drain,
 * because a reap tick still tears its worktree's forwards down.
 */
let clusterCache: ClusterCache | null = null
let statusWatchers: StatusWatcherManager | null = null
let portDetector: PortDetectorManager | null = null
const changeListeners: ((source: ChangeSource) => void)[] = []

async function attachNow(): Promise<void> {
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

  // A server restart loses the in-memory forwarder registry while
  // running containers keep their tmux `status-right` advertising
  // ports that aren't actually forwarded anymore. Rebuild forwarders
  // for every live worktree container before we process RPCs so the
  // displayed port mapping matches reality.
  try {
    await restoreAllWorktreeForwarders()
  } catch (err) {
    serverLog(`[server] restore forwarders failed: ${String(err)}`)
  }

  // Push-fed worktree state: the informer caches keep the display path's
  // pod cache current, drive the per-worktree status watchers (tmux
  // control-mode streams feeding the status store), and feed the
  // reconciler's delta triggers. Pod deltas fire a change notification, so
  // snapshots push the moment state changes.
  const cache = new ClusterCache()
  // The ACP driver needs a worktree's already-recorded conversations to
  // re-address a live agent (and to `session/load` after a restart), and
  // which conversation sits on a handle is a row.
  const manager = new StatusWatcherManager({
    recordedSessions: (session) =>
      recordedConversationHandles(session.slug, session.worktreeId),
  })
  // Detected-listener streams (streamd `ports` pushes) feeding the
  // snapshot's unforwardedPorts; a set change pushes a fresh snapshot.
  const detector = new PortDetectorManager(() => notifyWorktreeListChanged())
  clusterCache = cache
  statusWatchers = manager
  portDetector = detector
  cache.onDelta((source) => {
    if (source === 'worktree-pods') {
      manager.sync(cache.worktreePods())
      detector.sync(cache.worktreePods())
      notifyWorktreeListChanged()
    }
    for (const fn of changeListeners) fn(source)
  })
  onWorktreeStatusChanged(() => notifyWorktreeListChanged())
  // A conversation appearing, going, or learning its id is a change the
  // reconcile steps owe work on, and no watch above can see it: for `acp`
  // the id comes from the in-pod handshake, well after the pod deltas
  // that created the window have gone quiet. Without this the worktree's
  // conversation rows — and so the webapp's chat pane — wait for the 60s
  // resync.
  onLiveAgentsChanged(() => {
    for (const fn of changeListeners) fn('live-agents')
  })
  cache.start()
  setActiveClusterCache(cache)

  // Remove per-project push registries whose project dir is gone —
  // catches `project remove` runs that raced an unavailable cluster.
  void gcOrphanProjectRegistries()
    .catch((err) => serverLog(`[server] orphan registry GC failed: ${String(err)}`))
}

/**
 * Attach to the substrate: informer caches, per-worktree status watchers,
 * the port detector, the cluster bootstrap, and the startup GCs.
 *
 * `onAttached` fires once really attached, which is not necessarily before
 * this resolves — a nested server defers every cluster touch until first
 * use so its born-at-zero vcluster stays asleep. The reconcile loop starts
 * from that callback rather than from the return, so a sleeping vcluster
 * is not woken by the loop's first pass.
 */
export async function attachConvergence(opts: { onAttached: () => void }): Promise<void> {
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
  // `onAttached` fires with the attach, not with this call: the
  // reconcile loop is convergence too, and starting it against a
  // sleeping vcluster is the same mistake as starting the caches.
  if (env.nested && !(await anyWorktreeDirsExist())) {
    armDeferredClusterBoot(async () => {
      serverLog('[server] nested: first cluster use — attaching (caches, reconciler)')
      await attachNow()
      opts.onAttached()
    })
    serverLog('[server] nested: cluster attach deferred until first use (vcluster stays asleep)')
    return
  }
  await attachNow()
  opts.onAttached()
}

/**
 * Stop everything push-fed, synchronously: informer watches, status
 * watchers, the port detector, and any host image build in flight.
 *
 * Separate from `releaseConvergence` because the reconcile loop drains
 * between the two — the watches must be down before the drain, and the
 * forwarders must survive it (a reap tick still tears its worktree down).
 */
export function stopConvergence(): void {
  // The informer watches hold open apiserver connections, and every
  // per-worktree control-mode exec is a long-lived kubectl process that
  // would otherwise outlive the server (orphaned to PID 1).
  setActiveClusterCache(null)
  clusterCache?.stop()
  statusWatchers?.stopAll()
  portDetector?.stopAll()
  // Abort in-flight host builds/pushes. Podman commits an image tag only
  // when the build finishes, so an orphaned `podman build` is invisible
  // to the next server's exists check — it would start a second build of
  // the same tag and the two would fight over the layer cache.
  killTrackedPodmanProcs()
}

/** Release what was borrowed from the host: port forwarders, the proxy
 *  control tunnel, the relay's port-forward child. */
export function releaseConvergence(): void {
  // Every active port-forwarder owns a listener server and a set of live
  // relay streams; without this the listeners survive the server
  // (orphaned to PID 1) and the next server stacks new ones on top via
  // restoreAllWorktreeForwarders. After the reconcile drain, because a
  // reap tick still tears its worktree's forwards down.
  stopAllWorktreeForwarders()
  // Same for the proxy control tunnel and the stream relay's
  // `kubectl port-forward` child — the deployed proxy itself stays up
  // for the next server to adopt.
  proxyClient.disconnect()
  invalidateRelayAddr()
}

/** Subscribe to change notifications from the convergence watches. */
export function onConvergenceChange(fn: (source: ChangeSource) => void): void {
  changeListeners.push(fn)
}
