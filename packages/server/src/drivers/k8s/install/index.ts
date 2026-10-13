// Public interface of cluster administration: what `yaac cluster install`,
// `check` and `delete` do (create the kind cluster and its CNI, build the
// images yaac ships, apply the in-cluster layers). It runs on the CLI's
// machine, never in the server. Lint rules enforce this: nothing under
// `src/` may import `#drivers/k8s/install`, and the CLI's commands may
// import only this barrel from the driver.
//
// This folder may import `#drivers/k8s/cluster` and `substrate`, but
// neither may import it. It alone drives the host's podman, which keeps
// the server free of a container-engine dependency
// (docs/trust-split-builds.md).
//
// Each name exported here needs a unit test in
// packages/server/test/drivers/k8s/install/.

export { ClusterInstallError, clusterArgError, type ClusterInstallArgs } from './arg-guards'
export { buildBuiltinImages } from './builtin-images'
export { runClusterCheck } from './check'
export { ClusterDeleteError, kindClusterExists, runClusterDelete } from './delete'
export { ensureGvisorRuntime } from './gvisor-installer'
export { ensureImageByTag, imageExists, pushImageToRegistry } from './host-images'
export { retireStaleGenerations } from './image-gc'
export { runClusterInstall } from './install'
export { foreignClusterRefusal } from './cluster-identity'
// `yaac cluster` binds the install its data dir records before any call.
export { bindInstall } from '#drivers/k8s/substrate'
export { ensureRootfulPodmanHost } from './podman'
export {
  clusterServerLogs,
  deployServerWorkload,
  deployedInstallIdentity,
  restartClusterServer,
  serverDeploymentExists,
  startClusterServer,
  stopClusterServer,
} from './server-deploy'
export { deleteStorageVolumes, ensureStorageClaims, type StorageShape } from './storage'
