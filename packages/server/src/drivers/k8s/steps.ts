import { reconcileImageSalvage } from '#drivers/k8s/workspaces'
import { reconcileRegistrationGc } from '#drivers/k8s/egress'
import {
  gcOrphanProjectRegistries,
  reconcileNodeSet,
  reconcileProjectRegistryGc,
} from '#drivers/k8s/cluster'
import {
  reconcileImagePrewarm,
  reconcileMainRegistryGc,
  reconcileNodeImageStores,
} from '#drivers/k8s/images'
import type { DriverReconcileSteps } from '#drivers/contract'

/**
 * The k8s driver's housekeeping steps for the reconcile pass: image
 * builds, image stores and registry GC. The order
 * within each group is set here; where the two groups run relative to the
 * domain's own steps is set by `defaultReconcileSteps`.
 *
 * Steps read no rows or config files. The pass supplies the project list
 * and each project's config (`ctx.projectIds()`, `ctx.projectConfig`).
 */
export function k8sReconcileSteps(): DriverReconcileSteps {
  return {
    prePool: [
      // Per-node registry hosts.toml and node-address policies, for a node
      // that joined since the last pass (an autoscaled one). Its first run
      // after a server start always syncs. Before the pool and the builds,
      // which may land on that node.
      { name: 'node-sync', triggers: [], run: async (ctx) => reconcileNodeSet(await ctx.projectIds()) },
      // Keep every project's image chain built. Runs before the
      // prewarm pool so a spare's create joins the builds already running.
      // Every resync: a warm sweep is a registry HEAD per layer per project.
      { name: 'image-prewarm', triggers: [], run: async (ctx) => {
        reconcileImagePrewarm(await ctx.projectIds(), ctx)
      } },
    ],
    maintenance: [
      // Push images built by nested engines to the project registry.
      { name: 'image-salvage', triggers: [], run: (ctx) => reconcileImageSalvage(ctx.terminating) },
      // Rebuild each project's node-local image store (the read-only lower
      // layer a nested workspace mounts) from its registry. Runs after the
      // salvage so it picks up just-pushed images, and before registry-gc,
      // which holds the registry read-only for minutes.
      { name: 'image-store', triggers: [], run: async (ctx) => {
        reconcileNodeImageStores(await ctx.projectIds())
      } },
      // Reclaim blobs in one project registry per pass, during a read-only
      // window (an active project is never idle). Runs after the salvage
      // so just-pushed images survive the collect.
      { name: 'registry-gc', triggers: [], run: async (ctx) =>
        reconcileProjectRegistryGc(new Set(await ctx.projectIds())) },
      // Delete registries that no live project owns.
      { name: 'orphan-registry-gc', triggers: [], every: 60 * 60_000, run: async (ctx) =>
        gcOrphanProjectRegistries(new Set(await ctx.projectIds())) },
      // Egress registrations left behind by a teardown that never ran.
      { name: 'registration-gc', triggers: [], run: (ctx) => reconcileRegistrationGc(ctx) },
      // Main registry GC: retire unused step-cache tags and image
      // generations, collect their blobs, then drop the nodes' copies of
      // what the registry no longer holds. Skips while anything is pushing.
      { name: 'main-registry-gc', triggers: [], every: 6 * 60 * 60_000, run: async (ctx) =>
        reconcileMainRegistryGc(await ctx.projectIds(), ctx) },
    ],
  }
}
