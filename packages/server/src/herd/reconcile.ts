import {
  gcOrphanEphemeralModuleDirs,
  reconcileAgentSessions,
  reconcileImageSalvage,
  reconcilePrewarmPool,
  reconcileSpawnRequests,
  reconcileStaleSessions,
} from '#features/sessions'
import { reconcileProxySshKeys, reconcileVclusterAttribution } from '#features/egress'
import {
  reconcileProjectRegistryGc,
  reconcileRedirectClaims,
  reconcileVclusters,
} from '#features/cluster'
import { reconcileBuildCacheGc, reconcileBuilderPodGc, reconcileImagePrewarm } from '#features/images'
import { reconcileHostImageGc } from '#features/image-engine'
import { createTickSnapshot, type TickSnapshot } from '#platform/k8s'
import { serverLog } from '#log'
import type { AgentTool } from '@yaac/shared/types'
import { DESIRED_SET_TRIGGERS } from './contract'
import type { HerdChangeSource, HerdReconcileOptions } from './contract'

/**
 * The herd's own convergence steps, in the order one pass runs them.
 *
 * The server drives the loop and owns the two steps that read or write rows —
 * publishing the desired set before this runs, generating titles after — but
 * everything that touches the substrate is here, sharing one view of it
 * (`TickSnapshot`) and isolating its own errors, so a wedged GC cannot stop a
 * reap. Moving the loop itself down is what makes the herd a process
 * (docs/plans/herd-split.md); until then this is the whole of what it would
 * carry with it.
 */
interface HerdStep {
  name: string
  /** Sources that dirty this step; every step also runs on a resync. */
  triggers: readonly (HerdChangeSource | 'poll')[]
  run: (snapshot: TickSnapshot, defaultTool?: AgentTool) => Promise<void>
}

function herdSteps(): HerdStep[] {
  return [
    // The same triggers the server publishes its desired set on, by sharing
    // the constant rather than repeating the list: absence only means
    // something against a set from THIS pass. Poll is in there because
    // in-pod tmux death is not a substrate event.
    { name: 'stale-sessions', triggers: DESIRED_SET_TRIGGERS,
      run: (s) => reconcileStaleSessions(s) },
    // Service in-session `yaac-spawn` requests queued at the egress proxy.
    // The drain is a herd job — the queue is at the proxy and the caller is
    // resolved from pod labels — but what a request MEANS is the server's,
    // so each one is reported up rather than created here.
    { name: 'spawn-requests', triggers: ['poll'],
      run: (s) => reconcileSpawnRequests({}, s) },
    // Leaked trust-split builder pods (server restarted mid-build) — the
    // label sweep backstop. Throttled internally. Ahead of image-prewarm on
    // purpose: a leaked builder's memory reservation is what stops the next
    // build from scheduling, so it has to go before builds are launched.
    { name: 'builder-pod-gc', triggers: [], run: () => reconcileBuilderPodGc() },
    // Keep every project's image chain built and pushed (detached tasks).
    // Before the prewarm pool: a spare's create then joins the
    // already-running builds. Throttled internally.
    { name: 'image-prewarm', triggers: [], run: () => reconcileImagePrewarm() },
    // Keep one prewarmed spare per active project (after the stale sweep so
    // counts reflect just-reaped sessions). No-op when the pool size is 0.
    { name: 'prewarm-pool', triggers: ['session-pods'],
      run: (s, defaultTool) => reconcilePrewarmPool(defaultTool ?? 'claude', s) },
    // Mid-session image salvage (nested engines → project registry). Throttled
    // internally per session; salvages run detached.
    { name: 'image-salvage', triggers: [], run: () => reconcileImageSalvage() },
    // Blob reclaim in one project registry per pass. It cannot wait for a
    // project to go idle — an active one never does — so it takes a
    // read-only maintenance window instead, and detaches. Throttled
    // internally; after the salvage, so a just-pushed generation is the
    // one that survives the collect.
    { name: 'registry-gc', triggers: [], run: () => reconcileProjectRegistryGc() },
    // Which agent sessions each worktree holds, which are live, and what each
    // opened with — read from the in-pod hook's link tree (or the ACP
    // handshake) crossed with the watcher's live agent set. The opening
    // message rides along because the sweep has just resolved the transcript
    // it would be read from. Reported as events; the server writes the rows,
    // and its title generation runs after this pass for that reason.
    // `live-agents` is here and nowhere else: it is the only step that reads
    // the watcher's live set, and it is what turns a fresh ACP handshake into
    // a conversation row within a debounce instead of within a resync.
    { name: 'agent-sessions', triggers: ['session-pods', 'live-agents'],
      run: (s) => reconcileAgentSessions(s) },
    // ssh-agent heal only (attach-only probe, never bootstraps): agent
    // identities are memory-only by design and need the server to re-upload
    // them after a proxy pod replacement.
    { name: 'proxy-ssh-keys', triggers: ['poll'], run: () => reconcileProxySshKeys() },
    // Per-session vclusters: orphan GC + host-side kubeconfig heal.
    { name: 'vclusters', triggers: ['vcluster-namespaces', 'session-pods', 'session-jobs'],
      run: (s) => reconcileVclusters(Date.now(), s) },
    // yaac-in-yaac: tell the outer proxy which outer session owns each
    // vcluster's pods. Poll re-pushes cover outer-proxy restarts.
    { name: 'vcluster-attribution',
      triggers: ['vcluster-namespaces', 'vcluster-pods', 'poll'],
      run: (s) => reconcileVclusterAttribution(s) },
    // yaac-in-yaac: validate each vcluster's redirect claims and republish
    // them for netd. Claim documents arrive through the vcluster syncer, so
    // a ConfigMap delta is the signal; pod deltas matter too, since a claim
    // is only as valid as the pod IPs it names.
    { name: 'redirect-claims',
      triggers: ['vcluster-namespaces', 'vcluster-configmaps', 'vcluster-pods'],
      run: (s) => reconcileRedirectClaims(s) },
    // Host podman image GC. Throttled internally to every few hours.
    { name: 'host-image-gc', triggers: [], run: () => reconcileHostImageGc() },
    // Registry-side counterpart: retire step-cache tags no build has used
    // in a cache-ttl and collect their blobs. Throttled internally, and it
    // stands down while anything is pushing.
    { name: 'build-cache-gc', triggers: [], run: () => reconcileBuildCacheGc() },
    // Per-workspace `.cached-packages/modules/<id>` dirs whose runtime is
    // gone — leftovers from crashes and host reboots. A startup sweep, run
    // from the loop rather than from `attach` because it must not delete a
    // dir a create is staging into, and which workspaces are mid-create is
    // the desired set the pass above it published. Self-gating: once per
    // herd life.
    { name: 'orphan-modules-gc', triggers: [], run: () => gcOrphanEphemeralModuleDirs() },
  ]
}

/**
 * Run one pass. Steps preserve the order above, share one substrate view, and
 * isolate their errors — the same contract the server's loop gives its own
 * steps, because a herd that stopped converging on one bad GC would be worse
 * than one that logs and carries on.
 */
export async function runHerdPass(opts: HerdReconcileOptions): Promise<void> {
  const snapshot = createTickSnapshot(opts.resync)
  for (const step of herdSteps()) {
    // Before each step, not just before the pass: shutdown stops the watches
    // first and bounds the drain, so a pass that kept starting reaps and GCs
    // after the abort would be working against caches that are already gone.
    if (opts.signal?.aborted) return
    if (!opts.resync && !step.triggers.some((t) => opts.triggers.has(t))) continue
    try {
      await step.run(snapshot, opts.defaultTool)
    } catch (err) {
      serverLog(`[server] reconcile step ${step.name} failed: ${String(err)}`)
    }
  }
}
