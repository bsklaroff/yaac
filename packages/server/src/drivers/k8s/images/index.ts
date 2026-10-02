// Public interface of the image handling that needs a cluster: sandboxed
// builder pods, the in-cluster registry promoter, the prewarm sweep, node
// image stores and main registry GC. The host-side half (podman build,
// content-hash tags, build rows, host GC) is #drivers/k8s/image-engine, which
// needs no cluster so `cluster install` can build netd's image.
//
// Each name exported here needs a unit test in
// packages/server/test/drivers/k8s/images/.

export { ensureImage } from './build-coordinator'
export { deleteLeakedBuilderPods } from './builder-pod'
export { reconcileImagePrewarm, retryImageBuild } from './image-prewarm'
export { salvageJobImages } from './image-promoter'
export { prepareWorkspaceImage } from './workspace-image'
export {
  ensureNodeImageStore,
  nodeImageStoreMount,
  reconcileNodeImageStores,
} from './store-writer'
export { reapNodeLocal } from './node-local-sweep'
export { reconcileMainRegistryGc } from './main-registry-gc'
