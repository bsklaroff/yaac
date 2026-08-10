import {
  gcOrphanEphemeralModuleDirs,
  importLegacyMeta,
  reconcileAgentSessions,
  reconcilePrewarmPool,
  reconcileSpawnRequests,
  reconcileStaleWorktrees,
} from '#domain/worktrees'
import { reconcileImageSalvage } from '#runtime/k8s/worktrees'
import { reconcileProxySshKeys, reconcileVclusterAttribution } from '#runtime/k8s/egress'
import {
  reconcileProjectRegistryGc,
  reconcileRedirectClaims,
  reconcileVclusters,
} from '#runtime/k8s/cluster'
import {
  reconcileBuildCacheGc,
  reconcileBuilderPodGc,
  reconcileImagePrewarm,
  reconcileNodeImageStores,
} from '#runtime/k8s/images'
import { reconcileHostImageGc } from '#runtime/k8s/image-engine'
import { reconcileGeneratedTitles } from '#domain/titles'
import { listProjectRows } from '#records'
import type { DeltaSource, TickSnapshot } from '#platform/k8s'
import type { AgentTool } from '@yaac/shared/types'

/** A source that can dirty a pass: an informer cache delta, the live-agent
 *  set (an in-pod event no informer sees), or the 5s poll lane. */
export type ReconcileTrigger = DeltaSource | 'live-agents' | 'poll'

export interface ReconcileStep {
  name: string
  /** Sources that dirty this step; every step also runs on resync. */
  triggers: readonly ReconcileTrigger[]
  run: (ctx: PassContext) => Promise<void>
}

export interface PassContext {
  /** Which sources dirtied this pass. */
  triggers: ReadonlySet<ReconcileTrigger>
  /** Whether this is the periodic run-everything pass. */
  resync: boolean
  /** Aborts the pass. Handed down so a step that fans out into many of its
   *  own can stop starting them the moment shutdown signals. */
  signal: AbortSignal
  /** The pass's shared substrate view — memoized, created on first use. */
  snapshot: () => TickSnapshot
  /** The configured default tool — memoized, read from its preference row
   *  on first use and handed to the steps that need it, so no substrate
   *  step reads a row itself. */
  defaultTool: () => Promise<AgentTool | undefined>
}

/**
 * One flat list, in the order a pass runs it. Titles are generated after
 * the conversation sweep so a just-captured opening message is eligible in
 * the same pass; the reaper needs no ordering against a publish, because
 * it reads the desired set itself at the top of its own step.
 */
export function defaultReconcileSteps(): ReconcileStep[] {
  return [
    // Carry a previous yaac's per-worktree metadata documents into rows.
    // FIRST, and self-gating to once per server life: the sweeps below read
    // the columns it fills — the spare flag a reap deletes a checkout on,
    // and the log offset the conversation fold trusts panes against — so
    // running either ahead of it would judge an install mid-upgrade against
    // columns nobody had written yet.
    //
    // No triggers, so it runs on resync passes only. That is sufficient
    // *because the first pass of a server's life is always a resync*
    // (`startReconciler` seeds one before the loop) and a pass runs its steps
    // in order, awaited. If that seeding ever changes, this needs a trigger
    // of its own rather than the ordering alone.
    { name: 'legacy-meta-import', triggers: [], run: () => importLegacyMeta() },
    // The stale reaper — first, so counts reflect just-reaped worktrees by
    // the time the prewarm pool runs. It reads what should exist from
    // records at the top of its pass; the sources here are the ones on
    // which a worktree may have appeared or gone, plus poll because in-pod
    // tmux death is not a substrate event.
    { name: 'stale-worktrees', triggers: ['worktree-pods', 'worktree-jobs', 'poll'],
      run: (ctx) => reconcileStaleWorktrees(ctx.snapshot()) },
    // Service in-worktree `yaac-spawn` requests queued at the egress proxy.
    // The drain resolves who called from pod labels; what a request MEANS
    // (tool precedence, the fan-out cap, the minted id) is `decideSpawn`'s.
    { name: 'spawn-requests', triggers: ['poll'],
      run: (ctx) => reconcileSpawnRequests({}, ctx.snapshot()) },
    // Leaked trust-split builder pods (server restarted mid-build) — the
    // label sweep backstop. Throttled internally. Ahead of image-prewarm on
    // purpose: a leaked builder's memory reservation is what stops the next
    // build from scheduling, so it has to go before builds are launched.
    { name: 'builder-pod-gc', triggers: [], run: () => reconcileBuilderPodGc() },
    // Keep every project's image chain built and pushed (detached tasks).
    // Before the prewarm pool: a spare's create then joins the
    // already-running builds. Throttled internally. Which projects exist is
    // a row question, so the slugs are resolved here and handed down — the
    // runtime sweep never reads records.
    { name: 'image-prewarm', triggers: [], run: async () => {
      const slugs = (await listProjectRows().catch(() => [])).map((r) => r.slug)
      reconcileImagePrewarm(slugs)
    } },
    // Keep one prewarmed spare per active project (after the stale sweep so
    // counts reflect just-reaped worktrees). No-op when the pool size is 0.
    { name: 'prewarm-pool', triggers: ['worktree-pods'],
      run: async (ctx) => reconcilePrewarmPool((await ctx.defaultTool()) ?? 'claude', ctx.snapshot()) },
    // Mid-worktree image salvage (nested engines → project registry).
    // Throttled internally per worktree; salvages run detached.
    { name: 'image-salvage', triggers: [], run: () => reconcileImageSalvage() },
    // Rebuild each project's node-local image store from its registry —
    // the read-only lower a fresh nested worktree mounts. After the salvage
    // so a just-pushed generation is the one a build picks up, and before
    // the registry collect, which holds that registry read-only for
    // minutes. Fires detached per project and is throttled internally; the
    // slug list is a row question, so it is resolved here like the prewarm
    // sweep's rather than in the runtime.
    { name: 'image-store', triggers: [], run: async () => {
      const slugs = (await listProjectRows().catch(() => [])).map((r) => r.slug)
      reconcileNodeImageStores(slugs)
    } },
    // Blob reclaim in one project registry per pass. It cannot wait for a
    // project to go idle — an active one never does — so it takes a
    // read-only maintenance window instead, and detaches. Throttled
    // internally; after the salvage, so a just-pushed generation is the
    // one that survives the collect.
    { name: 'registry-gc', triggers: [], run: () => reconcileProjectRegistryGc() },
    // Which agent sessions each worktree holds, which are live, and what
    // each opened with — the in-pod hook's session-starts log folded into
    // rows and read back (or, under `acp`, the handshake), crossed with the
    // watcher's live agent set. The
    // opening message rides along because the sweep has just resolved the
    // transcript it would be read from; title generation runs after this
    // step for that reason. `live-agents` is here and nowhere else: it is
    // the only step that reads the watcher's live set, and it is what turns
    // a fresh ACP handshake into a conversation row within a debounce
    // instead of within a resync.
    { name: 'agent-sessions', triggers: ['worktree-pods', 'live-agents'],
      run: (ctx) => reconcileAgentSessions(ctx.snapshot()) },
    // ssh-agent heal only (attach-only probe, never bootstraps): agent
    // identities are memory-only by design and need the server to re-upload
    // them after a proxy pod replacement.
    { name: 'proxy-ssh-keys', triggers: ['poll'], run: () => reconcileProxySshKeys() },
    // Per-worktree vclusters: orphan GC + host-side kubeconfig heal.
    { name: 'vclusters', triggers: ['vcluster-namespaces', 'worktree-pods', 'worktree-jobs'],
      run: (ctx) => reconcileVclusters(Date.now(), ctx.snapshot()) },
    // yaac-in-yaac: tell the outer proxy which outer worktree owns each
    // vcluster's pods. Poll re-pushes cover outer-proxy restarts.
    { name: 'vcluster-attribution',
      triggers: ['vcluster-namespaces', 'vcluster-pods', 'poll'],
      run: (ctx) => reconcileVclusterAttribution(ctx.snapshot()) },
    // yaac-in-yaac: validate each vcluster's redirect claims and republish
    // them for netd. Claim documents arrive through the vcluster syncer, so
    // a ConfigMap delta is the signal; pod deltas matter too, since a claim
    // is only as valid as the pod IPs it names.
    { name: 'redirect-claims',
      triggers: ['vcluster-namespaces', 'vcluster-configmaps', 'vcluster-pods'],
      run: (ctx) => reconcileRedirectClaims(ctx.snapshot()) },
    // Host podman image GC. Throttled internally to every few hours.
    { name: 'host-image-gc', triggers: [], run: () => reconcileHostImageGc() },
    // Registry-side counterpart: retire step-cache tags no build has used
    // in a cache-ttl and collect their blobs. Throttled internally, and it
    // stands down while anything is pushing.
    { name: 'build-cache-gc', triggers: [], run: () => reconcileBuildCacheGc() },
    // Per-worktree `.cached-packages/modules/<id>` dirs whose runtime is
    // gone — leftovers from crashes and host reboots. A startup sweep that
    // must not delete a dir a create is staging into: which worktrees are
    // mid-create comes straight from the provisioning registry, which is
    // same-process and populated synchronously before a create stages
    // anything, so the sweep can never see a fresher directory than the
    // registry entry that shields it. Self-gating: once per server life.
    { name: 'orphan-modules-gc', triggers: [], run: () => gcOrphanEphemeralModuleDirs() },
    // Model-generated titles for untitled worktrees, after the
    // conversation sweep so a freshly captured prompt is eligible the same
    // pass — which means it owes a pass on whatever dirties that sweep.
    // Cheap when there is nothing to do.
    { name: 'generated-titles', triggers: ['worktree-pods', 'live-agents'],
      run: () => reconcileGeneratedTitles() },
  ]
}

