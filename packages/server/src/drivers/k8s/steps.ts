import { unmarkClaimedJobs } from '#drivers/k8s/workspaces'
import { reconcileRegistrationGc } from '#drivers/k8s/egress'
import { reconcileNodeSet, sweepProjectRegistries } from '#drivers/k8s/cluster'
import { reconcileMainRegistryGc } from '#drivers/k8s/images'
import type { DriverReconcileSteps } from '#drivers/contract'

/**
 * The k8s driver's housekeeping steps for the reconcile pass: node sync
 * and registry GC. The order within each group is set here; where
 * the two groups run relative to the domain's own steps is set by
 * `defaultReconcileSteps`.
 *
 * Steps read no rows. The pass supplies the project list
 * (`ctx.projectIds()`) and the image tags to keep (`ctx.keptImageTags`).
 */
export function k8sReconcileSteps(): DriverReconcileSteps {
  return {
    prePool: [
      // Per-node registry hosts.toml and node-address policies, for a node
      // that joined since the last pass (an autoscaled one). Its first run
      // after a server start always syncs. Before the pool and the builds,
      // which may land on that node.
      { name: 'node-sync', triggers: [], run: () => reconcileNodeSet() },
    ],
    maintenance: [
      // Project registries an older server left (docs/legacy-compat-shims.md).
      { name: 'project-registry-sweep', triggers: [], every: 60 * 60_000, run: () => sweepProjectRegistries() },
      // Spare labels an older server's claims left on Jobs
      // (docs/legacy-compat-shims.md).
      { name: 'unmark-claimed-jobs', triggers: [], run: () => unmarkClaimedJobs() },
      // Egress registrations left behind by a teardown that never ran.
      { name: 'registration-gc', triggers: [], run: (ctx) => reconcileRegistrationGc(ctx) },
      // Main registry GC: retire superseded build caches and image
      // generations, collect their blobs, then drop the nodes' copies of
      // what the registry no longer holds. Skips while anything is pushing.
      { name: 'main-registry-gc', triggers: [], every: 6 * 60 * 60_000, run: async (ctx) =>
        reconcileMainRegistryGc(await ctx.projectIds(), ctx) },
    ],
  }
}
