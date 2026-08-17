import { reconcileImageSalvage } from '#drivers/k8s/worktrees'
import { reconcileProxySshKeys } from '#drivers/k8s/egress'
import { reconcileProjectRegistryGc } from '#drivers/k8s/cluster'
import {
  reconcileBuildCacheGc,
  reconcileBuilderPodGc,
  reconcileImagePrewarm,
  reconcileNodeImageStores,
} from '#drivers/k8s/images'
import type { DriverReconcileSteps } from '#drivers/contract'

/**
 * The k8s runtime's own upkeep, as steps a pass can schedule.
 *
 * These moved off the mediators' step list because every one of them is
 * substrate housekeeping — leaked builder pods, registry blobs, image
 * stores — and the reasons they are ordered the way they
 * are are substrate reasons. What the mediators still own is where the two
 * GROUPS sit relative to their own steps, which is the only ordering they
 * have a stake in (see `defaultReconcileSteps`).
 *
 * Nothing here reads a row or a config file: which projects exist and what
 * each one's config says are questions the layers above own, so the pass
 * hands the answers down (`ctx.projectSlugs()`, `ctx.projectConfig`).
 */
export function k8sReconcileSteps(): DriverReconcileSteps {
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
      { name: 'image-salvage', triggers: [], run: (ctx) => reconcileImageSalvage(ctx.terminating) },
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
      // Registry-side counterpart: retire step-cache tags no build has used
      // in a cache-ttl and collect their blobs. Throttled internally, and it
      // stands down while anything is pushing.
      { name: 'build-cache-gc', triggers: [], run: () => reconcileBuildCacheGc() },
    ],
  }
}
