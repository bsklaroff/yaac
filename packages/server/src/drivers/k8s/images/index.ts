// Public interface of image handling on the cluster: sandboxed builder
// pods, the in-cluster registry promoter, the prewarm sweep, node image
// stores, main registry GC, and the in-memory build rows the webapp shows.
// The yaac-shipped images are built on the host by `#drivers/k8s/install`;
// their tags come from `#drivers/k8s/cluster`.
//
// Each name exported here needs a unit test in
// packages/server/test/drivers/k8s/images/.

export { ensureImage } from './build-coordinator'
export { deleteLeakedBuilderPods } from './builder-pod'
export { dismissImageBuild, getImageBuildLog, listImageBuilds } from './image-builds'
export { reconcileImagePrewarm, retryImageBuild } from './image-prewarm'
export { salvageJobImages } from './image-promoter'
export { prepareWorkspaceImage } from './workspace-image'
export {
  ensureNodeImageStore,
  nodeImageStoreMount,
  reconcileNodeImageStores,
} from './store-writer'
export { reconcileMainRegistryGc } from './main-registry-gc'
