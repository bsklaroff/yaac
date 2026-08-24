// The public interface of the install feature: everything `yaac cluster
// install`, `check` and `delete` do, and nothing the server does.
//
// This folder is the one part of the k8s driver the SERVER never enters.
// It administers the substrate — creates the kind cluster and its CNI,
// re-applies the node state a restart drops, produces every image yaac
// ships, and converges the in-cluster layers — all of which happens on the
// machine running the yaac CLI, before (and independently of) any server.
// The lint zones say so directly: nothing under `src/` may import
// `#drivers/k8s/install`, and `packages/cli/src/commands` may import this
// door and nothing else of the driver.
//
// That is also why the arrow points the way it does. This folder reads
// `#drivers/k8s/cluster` — for each shipped image's identity, and for the
// in-cluster layers both sides ensure — plus the driver's own bottom
// (`#drivers/k8s/substrate`, `#drivers/k8s/container`,
// `#drivers/k8s/image-engine`). Nothing reads back: a cluster module that
// imported this one would put the server back on a path that needs a
// container engine, which is the whole property this split protects
// (docs/trust-split-builds.md).
//
// Adding a name here widens the interface and obliges a unit test in
// packages/server/test/drivers/k8s/install/.

export {
  ClusterDeleteError,
  ClusterInstallError,
  MAX_KIND_NODES,
  clusterArgError,
  type ClusterInstallArgs,
} from './arg-guards'
export { buildBuiltinImages } from './builtin-images'
export { formatCheckResult, runClusterCheck } from './check'
export { runClusterDelete } from './delete'
export { ensureGvisorRuntime } from './gvisor-installer'
export { runClusterInstall } from './install'
export {
  deployServerWorkload,
  restartClusterServer,
  serverDeploymentExists,
  serverPublishedOrigin,
  startClusterServer,
  stopClusterServer,
  waitForPublishedServer,
} from './server-deploy'
