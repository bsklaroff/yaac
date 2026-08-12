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
import type { RuntimeReconcileSteps } from '#runtime/contract'

/**
 * The k8s runtime's own upkeep, as steps a pass can schedule.
 *
 * These moved off the mediators' step list because every one of them is
 * substrate housekeeping — leaked builder pods, registry blobs, vcluster
 * orphans, redirect claims — and the reasons they are ordered the way they
 * are are substrate reasons. What the mediators still own is where the two
 * GROUPS sit relative to their own steps, which is the only ordering they
 * have a stake in (see `defaultReconcileSteps`).
 *
 * Nothing here reads a row or a config file: which projects exist and what
 * each one's config says are questions the layers above own, so the pass
 * hands the answers down (`ctx.projectSlugs()`, `ctx.projectConfig`).
 */
export function k8sReconcileSteps(): RuntimeReconcileSteps {
  return {
    prePool: [
      // Leaked trust-split builder pods (server restarted mid-build) — the
      // label sweep backstop. Throttled internally. Ahead of image-prewarm on
      // purpose: a leaked builder's memory reservation is what stops the next
      // build from scheduling, so it has to go before builds are launched.
      { name: 'builder-pod-gc', triggers: [], run: () => reconcileBuilderPodGc() },
      // Keep every project's image chain built and pushed (detached tasks).
      // Before the prewarm pool: a spare's create then joins the
      // already-running builds. Throttled internally.
      { name: 'image-prewarm', triggers: [], run: async (ctx) => {
        reconcileImagePrewarm(await ctx.projectSlugs(), ctx.projectConfig)
      } },
    ],
    maintenance: [
      // Mid-worktree image salvage (nested engines → project registry).
      // Throttled internally per worktree; salvages run detached.
      { name: 'image-salvage', triggers: [], run: () => reconcileImageSalvage() },
      // Rebuild each project's node-local image store from its registry —
      // the read-only lower a fresh nested worktree mounts. Between the two
      // neighbours on purpose: after the salvage, so a just-pushed
      // generation is the one a build picks up, and before the registry
      // collect, which holds that registry read-only for minutes. Fires
      // detached per project and is throttled internally.
      { name: 'image-store', triggers: [], run: async (ctx) => {
        reconcileNodeImageStores(await ctx.projectSlugs())
      } },
      // Blob reclaim in one project registry per pass. It cannot wait for a
      // project to go idle — an active one never does — so it takes a
      // read-only maintenance window instead, and detaches. Throttled
      // internally; after the salvage, so a just-pushed generation is the
      // one that survives the collect.
      { name: 'registry-gc', triggers: [], run: () => reconcileProjectRegistryGc() },
      // ssh-agent heal only (attach-only probe, never bootstraps): agent
      // identities are memory-only by design and need the server to re-upload
      // them after a proxy pod replacement. A replacement necessarily kills
      // the proxy event stream, so its reattach IS the heal's edge; the step
      // still checks the loss signature itself, so a merely flaky tunnel
      // re-uploads nothing.
      { name: 'proxy-ssh-keys', triggers: ['proxy-reconnect'], run: () => reconcileProxySshKeys() },
      // Per-worktree vclusters: orphan GC + host-side kubeconfig heal.
      { name: 'vclusters', triggers: ['vcluster-namespaces', 'workspaces', 'units'],
        run: (ctx) => reconcileVclusters(Date.now(), ctx.snapshot()) },
      // yaac-in-yaac: tell the outer proxy which outer worktree owns each
      // vcluster's pods. A stream reattach re-pushes, which is what covers
      // an outer-proxy restart (the restart is what dropped the stream).
      { name: 'vcluster-attribution',
        triggers: ['vcluster-namespaces', 'vcluster-pods', 'proxy-reconnect'],
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
    ],
  }
}
